/**
 * Tests for:
 *   §5.4  onReady() → Promise<InitResult> (never rejects)
 *   §5.5  logger + onError callbacks
 *   §5.6  track() with unified TrackPayload
 *   §5.13 Flag<T> unified return shape
 *   §5.18 engine subpath removal (index.ts no longer re-exports evaluateFlag)
 *   context synthesis (anonymous id generation)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { AvsbClient } from './AvsbClient'
import type { FlagDatafile, Tracker, MetricEvent } from './types'
import * as trackerModule from './tracker'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_DATAFILE: FlagDatafile = {
  version: 1,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk_production_flagtest0001',
  environmentKey: 'production',
  publishedAt: '2025-01-01T00:00:00Z',
  collectEndpoint: 'http://localhost:3001',
  flags: [],
  audiences: [],
}

function makeTrackerSpy(): { tracker: Tracker; queueMetricMock: ReturnType<typeof vi.fn> } {
  const queueMetricMock = vi.fn()
  const tracker: Tracker = {
    queue: vi.fn(),
    queueMetric: queueMetricMock,
    flush: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
  return { tracker, queueMetricMock }
}

// vi.stubGlobal DEFINES the property instead of assigning to it, so it works
// whatever shape the environment gives `fetch` (data property, settable
// accessor, or getter-only accessor). vi.unstubAllGlobals() restores the
// original descriptor, so no manual save/restore is needed.
function setGlobalFetch(mock: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('fetch', mock)
}

// The client caches datafiles in localStorage (cache-then-network), so tests
// that assert on init behaviour have to start from a cold browser or a
// previous test's cached copy would make them ready before they fetch.
beforeEach(() => {
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// §5.4 onReady() — Promise<InitResult>, never rejects
// ---------------------------------------------------------------------------

describe('AvsbClient.onReady() — InitResult', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('resolves with { success: true, source: "bootstrap" } when bootstrapped', async () => {
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      bootstrap: MINIMAL_DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    const readyPromise = client.onReady()
    await vi.advanceTimersByTimeAsync(0)
    const result = await readyPromise

    expect(result.success).toBe(true)
    expect(result.source).toBe('bootstrap')
  })

  it('resolves with { success: true, source: "network" } on successful fetch', async () => {
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
    setGlobalFetch(vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MINIMAL_DATAFILE),
    }))

    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    const result = await client.onReady()

    expect(result.success).toBe(true)
    expect(result.source).toBe('network')
  })

  // Breaking change B1 (spec §3): a failed fetch with nothing to fall back on
  // is a FAILED init. It used to resolve `{ success: true, degraded: true }`,
  // which combined with the old noop logger meant a typo'd SDK key produced no
  // signal anywhere. `degraded` now means one thing only: serving a stale
  // bootstrap or cache after a failed refresh.
  it('resolves (never rejects) with success=false when fetch fails and there is nothing to serve', async () => {
    setGlobalFetch(vi.fn().mockRejectedValue(new Error('network down')))

    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    const result = await client.onReady()

    expect(result.success).toBe(false)
    expect(result.source).toBe('error')
    expect(result.degraded).toBeUndefined()
    expect(result.error).toBeInstanceOf(Error)
    expect(client.isReady()).toBe(false)
  })

  it('returns the same Promise on repeated calls', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      bootstrap: MINIMAL_DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    const p1 = client.onReady()
    const p2 = client.onReady()
    expect(p1).toBe(p2)
  })
})

// ---------------------------------------------------------------------------
// §5.5 logger + onError
// ---------------------------------------------------------------------------

describe('AvsbClient — logger + onError (§5.5)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('calls onError with source="init" when datafile fetch throws', async () => {
    const onError = vi.fn()
    setGlobalFetch(vi.fn().mockRejectedValue(new Error('fetch failed')))

    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
      onError,
    })

    await client.onReady()
    expect(onError).toHaveBeenCalledOnce()
    const [err, source] = onError.mock.calls[0] as [Error, string]
    expect(err).toBeInstanceOf(Error)
    expect(source).toBe('init')
  })

  it('calls logger.error when datafile fetch fails', async () => {
    const errorSpy = vi.fn()
    setGlobalFetch(vi.fn().mockRejectedValue(new Error('nope')))

    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
      logger: {
        debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: errorSpy,
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({} as import('@avsbhq/core').Logger) }),
      },
    })

    await client.onReady()
    expect(errorSpy).toHaveBeenCalledOnce()
    // Spec §1.2: the message has to name what failed and where, not just
    // that something went wrong.
    const message = errorSpy.mock.calls[0][0] as string
    expect(message).toContain('datafile')
    expect(message).toContain('cdn.avsb.cloud')
  })

  it('emits "error" on event bus when fetch fails', async () => {
    setGlobalFetch(vi.fn().mockRejectedValue(new Error('down')))

    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    const errorListener = vi.fn()
    client.on('error', errorListener)

    await client.onReady()
    expect(errorListener).toHaveBeenCalledOnce()
    expect(errorListener.mock.calls[0][0]).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// §5.6 track() with unified TrackPayload
// ---------------------------------------------------------------------------

describe('AvsbClient.track() — unified TrackPayload (§5.6)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('maps money to revenue and a quantity to value, as separate columns', async () => {
    const { tracker, queueMetricMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      bootstrap: MINIMAL_DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })
    await client.onReady()

    client.track('purchase', { revenue: 99.95, value: 4 })

    const evt = queueMetricMock.mock.calls[0][0] as MetricEvent
    expect(evt.revenue).toBe(99.95)
    expect(evt.value).toBe(4)
  })

  it('does not forward properties: the metric wire has no such column', async () => {
    const { tracker, queueMetricMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      bootstrap: MINIMAL_DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })
    await client.onReady()

    client.track('add_to_cart', { properties: { productId: 'sku-42', qty: 2 } })

    const evt = queueMetricMock.mock.calls[0][0] as MetricEvent
    expect('properties' in evt).toBe(false)
  })

  it('sets both numeric columns to null when nothing is provided', async () => {
    const { tracker, queueMetricMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      bootstrap: MINIMAL_DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })
    await client.onReady()

    client.track('page_view')
    const evt = queueMetricMock.mock.calls[0][0] as MetricEvent
    expect(evt.revenue).toBeNull()
    expect(evt.value).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// §5.13 Flag<T> unified return shape
// ---------------------------------------------------------------------------

describe('Flag<T> shape — §5.13', () => {
  afterEach(() => vi.restoreAllMocks())

  it('getFlag returns a Flag object, not a raw value', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      bootstrap: MINIMAL_DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    const flag = client.getFlag('phantom', 42)
    // Must have the Flag shape.
    expect(typeof flag.value).toBe('number')
    expect(typeof flag.source).toBe('string')
    expect(typeof flag.isEnabled).toBe('function')
    expect(typeof flag.exists).toBe('function')
    expect(Array.isArray(flag.reasons)).toBe(true)
  })

  it('exists() returns false for not_found flags', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      bootstrap: MINIMAL_DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    expect(client.getFlag('phantom', 0).exists()).toBe(false)
  })

  it('flag is frozen (immutable)', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      bootstrap: MINIMAL_DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    const flag = client.getFlag('phantom', 'x')
    expect(Object.isFrozen(flag)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Context synthesis — anonymous key generation
// ---------------------------------------------------------------------------

describe('AvsbClient — context synthesis', () => {
  // These three are the only clients in this file built with neither a
  // bootstrap nor a fetch double, so the default autoInit put a real datafile
  // request on the wire the moment the constructor ran, at the PRODUCTION CDN:
  // https://cdn.avsb.cloud/sdk_production_flagtest0001/datafile.json. This is
  // exactly the hazard AvsbClient.bootstrap.test.ts warns about in its header.
  // Nothing here awaits readiness, so all three were still in flight when the
  // file ended and happy-dom's window teardown aborted them, which is where
  // the three stray AbortErrors in `vitest run packages/` came from.
  //
  // Every assertion below reads getContext(), which is synchronous and settled
  // in the constructor, so the double cannot change a result. 404 is what the
  // CDN really answers for an invented key, so the client takes the same
  // branch it takes today.
  beforeEach(() => {
    setGlobalFetch(vi.fn().mockResolvedValue({ ok: false, status: 404 }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('generates an anonymous key when neither context nor userId attribute is provided', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      autoRefresh: false,
    })

    const ctx = client.getContext() as { kind: string; key: string; _meta?: { anonymous?: boolean } }
    expect(ctx.kind).toBe('user')
    expect(ctx.key.startsWith('anon_')).toBe(true)
    expect(ctx._meta?.anonymous).toBe(true)
  })

  it('carries the context through untouched, attributes and all', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      autoRefresh: false,
      context: { kind: 'user', key: 'from-context', plan: 'pro' },
    })

    const ctx = client.getContext() as { kind: string; key: string; plan: string }
    expect(ctx.kind).toBe('user')
    expect(ctx.key).toBe('from-context')
    expect(ctx.plan).toBe('pro')
  })

  it('keeps a multi-context as the bound identity', () => {
    const explicit = {
      kind: 'multi' as const,
      user: { kind: 'user', key: 'explicit-user', role: 'admin' },
      organization: { kind: 'organization', key: 'org_1' },
    }
    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      autoRefresh: false,
      context: explicit,
    })

    expect(client.getContext()).toEqual(explicit)
  })
})

// ---------------------------------------------------------------------------
// on() event bus — §5.14-adjacent
// ---------------------------------------------------------------------------

describe('AvsbClient.on() — event bus', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('emits "ready" event when init completes', async () => {
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
    setGlobalFetch(vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MINIMAL_DATAFILE),
    }))

    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    const readyListener = vi.fn()
    client.on('ready', readyListener)

    await client.onReady()
    expect(readyListener).toHaveBeenCalledOnce()
    const [result] = readyListener.mock.calls[0] as [{ success: boolean }]
    expect(result.success).toBe(true)
  })

  it('on() returns an unsubscribe function', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      bootstrap: MINIMAL_DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    const listener = vi.fn()
    const unsub = client.on('flagChange', listener)
    expect(typeof unsub).toBe('function')

    unsub()
    // After unsubscribe, no listener should fire.
    client.updateAttributes({ foo: 'bar' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('emits "flagChange" when a flag value changes', () => {
    const datafile: FlagDatafile = {
      version: 1,
      projectType: 'FEATURE_FLAG',
      sdkKey: 'sdk_production_flagtest0001',
      environmentKey: 'production',
      publishedAt: '2025-01-01T00:00:00Z',
      collectEndpoint: 'http://localhost:3001',
      audiences: [{
        id: 'aud-1',
        rules: {
          id: 'g1', logic: 'AND',
          conditions: [{
            id: 'c1', type: 'CUSTOM_ATTRIBUTE',
            attribute: 'role', operator: 'equals', value: 'admin',
          }],
        },
      }],
      flags: [{
        id: 'f1', key: 'admin_flag', type: 'boolean',
        enabled: true, defaultVariationId: 'voff',
        variations: [
          { id: 'voff', key: 'off', value: false },
          { id: 'von', key: 'on', value: true },
        ],
        overrides: [],
        rules: [{
          id: 'r1', type: 'targeted_delivery', enabled: true,
          audienceIds: ['aud-1'], hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'von', percentage: 1 }],
        }],
      }],
    }

    const client = new AvsbClient({
      sdkKey: 'sdk_production_flagtest0001',
      bootstrap: datafile,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', role: 'guest' },
    })

    const changeSpy = vi.fn()
    client.on('flagChange', changeSpy)

    client.updateAttributes({ role: 'admin' })

    expect(changeSpy).toHaveBeenCalledOnce()
    const [data] = changeSpy.mock.calls[0] as [{ flagKey: string; previousValue: unknown; newValue: unknown }]
    expect(data.flagKey).toBe('admin_flag')
    expect(data.previousValue).toBe(false)
    expect(data.newValue).toBe(true)
  })
})
