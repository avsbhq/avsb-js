import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AvsbClient } from './AvsbClient'
import type { FlagDatafile, MetricEvent, Tracker } from './types'
import * as trackerModule from './tracker'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_DATAFILE: FlagDatafile = {
  version: 1,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'test-key',
  environmentKey: 'production',
  publishedAt: '2024-01-01T00:00:00Z',
  collectEndpoint: 'http://localhost:3001/v1/collect/batch',
  flags: [],
  audiences: [],
}

function createBootstrapDatafile(
  overrides?: Partial<FlagDatafile>
): FlagDatafile {
  return {
    version: 1,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'sdk_test_123',
    environmentKey: 'production',
    publishedAt: '2025-01-01T00:00:00Z',
    collectEndpoint: 'http://localhost:3001',
    flags: [
      {
        id: 'flag1',
        key: 'test_flag',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'var_off',
        variations: [
          { id: 'var_off', key: 'off', value: false },
          { id: 'var_on', key: 'on', value: true },
        ],
        overrides: [],
        rules: [
          {
            id: 'rule1',
            type: 'targeted_delivery',
            enabled: true,
            audienceIds: [],
            hashAttribute: 'userId',
            trafficAllocation: null,
            variations: [{ variationId: 'var_on', percentage: 1 }],
          },
        ],
      },
    ],
    audiences: [],
    ...overrides,
  }
}

function makeTrackerSpy(): { tracker: Tracker; queueMetricMock: ReturnType<typeof vi.fn> } {
  const queueMetricMock = vi.fn()
  const tracker: Tracker = {
    queue: vi.fn(),
    queueMetric: queueMetricMock,
    flush: vi.fn(),
    destroy: vi.fn(),
  }
  return { tracker, queueMetricMock }
}

// vi.stubGlobal DEFINES the property instead of assigning to it, so it works
// whatever shape the environment gives `fetch` (data property, settable
// accessor, or getter-only accessor). vi.unstubAllGlobals() restores the
// original descriptor, so no manual save/restore is needed.
function mockFetchWithDatafile(datafile: FlagDatafile = MINIMAL_DATAFILE): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(datafile),
    } as Response),
  )
}

// The client caches datafiles in localStorage (cache-then-network), so a
// datafile cached by an earlier test would otherwise make a later client with
// the same SDK key ready before it fetches anything.
beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

// ---------------------------------------------------------------------------
// Tests — track() visitor ID resolution
// ---------------------------------------------------------------------------

describe('AvsbClient.track() — visitor ID resolution', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("uses 'userId' from context attributes by default", async () => {
    mockFetchWithDatafile()
    const { tracker, queueMetricMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'test',
      context: { kind: 'user', key: 'user-123' },
      autoRefresh: false,
    })

    await client.onReady()
    client.track('purchase')

    expect(queueMetricMock).toHaveBeenCalledOnce()
    const event = queueMetricMock.mock.calls[0][0] as MetricEvent
    expect(event.visitorId).toBe('user-123')
    expect(event.eventName).toBe('purchase')

    client.close()
  })

  it('attributes events to the context key, the one identity there is (B5)', async () => {
    // The `attributes` + `userIdAttribute` pair is gone: a context used to be
    // able to bucket on one id and report its events under another.
    mockFetchWithDatafile()
    const { tracker, queueMetricMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'test',
      context: { kind: 'user', key: 'hash-456', visitorHash: 'ignored-now' },
      autoRefresh: false,
    })

    await client.onReady()
    client.track('add_to_cart')

    expect(queueMetricMock).toHaveBeenCalledOnce()
    const event = queueMetricMock.mock.calls[0][0] as MetricEvent
    expect(event.visitorId).toBe('hash-456')

    client.close()
  })

  it('does not put track properties on the metric wire, because ingestion drops them', async () => {
    mockFetchWithDatafile()
    const { tracker, queueMetricMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'test',
      context: { kind: 'user', key: 'anon-ctx' },
      autoRefresh: false,
    })

    await client.onReady()
    client.track('page_view', { value: 3, properties: { page: '/checkout' } })

    const event = queueMetricMock.mock.calls[0][0] as MetricEvent
    expect(event.visitorId).toBe('anon-ctx')
    expect(event.value).toBe(3)
    expect('properties' in event).toBe(false)

    client.close()
  })

  it('queues events when the tracker has not been initialized yet', async () => {
    // Spec §4 fix #1 — pre-ready track calls used to be silently dropped.
    // They now queue and flush on tracker init.
    const { tracker, queueMetricMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
    mockFetchWithDatafile()

    const client = new AvsbClient({
      sdkKey: 'test',
      context: { kind: 'user', key: 'user-789' },
      autoRefresh: false,
    })

    expect(() => client.track('checkout')).not.toThrow()
    // No tracker yet → nothing queued via the (eventual) tracker spy.
    expect(queueMetricMock).not.toHaveBeenCalled()

    await client.onReady()

    // Pre-ready event drained on init.
    expect(queueMetricMock).toHaveBeenCalledOnce()
    const event = queueMetricMock.mock.calls[0][0] as MetricEvent
    expect(event.eventName).toBe('checkout')
    expect(event.visitorId).toBe('user-789')

    await client.close()
  })

  it('maps revenue and value to their own wire columns', async () => {
    // Two columns end to end: the metric_batch fixture declares both and
    // metric_events stores both. `value` used to be written into `revenue`,
    // so a quantity was recorded as money.
    mockFetchWithDatafile()
    const { tracker, queueMetricMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'test',
      context: { kind: 'user', key: 'rev-user' },
      autoRefresh: false,
    })

    await client.onReady()
    client.track('purchase', { revenue: 49.99, value: 2 })

    const event = queueMetricMock.mock.calls[0][0] as MetricEvent
    expect(event.revenue).toBe(49.99)
    expect(event.value).toBe(2)
    expect(event.visitorId).toBe('rev-user')

    client.close()
  })

  it('sets revenue and value to null when no payload is passed', async () => {
    mockFetchWithDatafile()
    const { tracker, queueMetricMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'test',
      context: { kind: 'user', key: 'user-abc' },
      autoRefresh: false,
    })

    await client.onReady()
    client.track('signup')

    const event = queueMetricMock.mock.calls[0][0] as MetricEvent
    expect(event.revenue).toBeNull()
    expect(event.value).toBeNull()

    client.close()
  })

  it('keeps the visitor while attributes change, and follows identify()', async () => {
    mockFetchWithDatafile()
    const { tracker, queueMetricMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'test',
      context: { kind: 'user', key: 'initial-user' },
      autoRefresh: false,
    })

    await client.onReady()

    // Attributes are attributes. Identity is the context KEY, and `userId` has
    // been an ordinary attribute since contexts became kinded, so merging one
    // must NOT silently re-identify the visitor mid-session.
    client.updateAttributes({ userId: 'updated-user', plan: 'enterprise' })
    client.track('profile_update')
    expect((queueMetricMock.mock.calls[0][0] as MetricEvent).visitorId).toBe('initial-user')

    // `identify` is the door that moves identity, and the tracker follows it.
    client.identify({ kind: 'user', key: 'updated-user' })
    client.track('after_identify')
    expect((queueMetricMock.mock.calls[1][0] as MetricEvent).visitorId).toBe('updated-user')

    client.close()
  })
})

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

describe('AvsbClient — bootstrap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('getFlag() returns bootstrapped value before onReady()', () => {
    const datafile = createBootstrapDatafile()
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      bootstrap: datafile,
      autoRefresh: false,
    })

    // Do NOT await onReady — bootstrap should make flags available immediately.
    const flag = client.getFlag('test_flag', false)
    expect(flag.value).toBe(true)

    client.close()
  })

  it('onReady() resolves immediately when bootstrapped', async () => {
    const datafile = createBootstrapDatafile()
    mockFetchWithDatafile(datafile)
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      bootstrap: datafile,
      autoRefresh: false,
    })

    const readyPromise = client.onReady()
    await vi.advanceTimersByTimeAsync(0)
    const result = await readyPromise

    expect(result.success).toBe(true)
    expect(result.source).toBe('bootstrap')
    expect(client.getFlag('test_flag', false).value).toBe(true)

    client.close()
  })

  it('getFlag() before any datafile reports not_ready, not not_found', () => {
    // Breaking change B15 (spec §1.2): "you asked before the datafile loaded"
    // and "that flag is not in your project" are different problems, and used
    // to report the same source.
    mockFetchWithDatafile()
    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      autoRefresh: false,
      autoInit: false,
    })

    const flag = client.getFlag('test_flag', false)
    expect(flag.value).toBe(false)
    expect(flag.source).toBe('not_ready')
    expect(flag.exists()).toBe(false)
    expect(flag.isEnabled()).toBe(false)

    const strFlag = client.getFlag('another_flag', 'default_val')
    expect(strFlag.value).toBe('default_val')

    client.close()
  })

  it('getAllFlags() works with bootstrap before onReady()', () => {
    const datafile = createBootstrapDatafile()
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      bootstrap: datafile,
      autoRefresh: false,
    })

    const allFlags = client.getAllFlags()
    expect(Object.keys(allFlags)).toHaveLength(1)
    // §5.7: getAllFlags returns Record<string, Flag> — check .value.
    expect(allFlags['test_flag']?.value).toBe(true)

    client.close()
  })

  it('reports the decision path on getFlag with a bootstrap datafile', () => {
    // Replaces the old `getFlagDetails()` coverage: that method was deleted
    // (B5) because `Flag<T>` already carries source, ruleId, and ruleType, and
    // a "details" read that fired an exposure was a trap.
    const datafile = createBootstrapDatafile()
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      bootstrap: datafile,
      autoRefresh: false,
    })

    const flag = client.getFlag('test_flag', false)
    expect(flag.value).toBe(true)
    expect(flag.source).toBe('rule')
    expect(flag.ruleType).toBe('targeted_delivery')
    expect(flag.exists()).toBe(true)

    client.close()
  })
})

// ---------------------------------------------------------------------------
// cdnHost
// ---------------------------------------------------------------------------

describe('AvsbClient — cdnHost', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('fetches the datafile from the default CDN host when no override is provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MINIMAL_DATAFILE),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_default',
      autoRefresh: false,
    })

    await client.onReady()

    const datafileCall = fetchMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && String(call[0]).includes('datafile.json')
    )
    expect(datafileCall?.[0]).toBe(
      'https://cdn.avsb.cloud/sdk_default/datafile.json'
    )

    client.close()
  })

  it('uses a custom cdnHost when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MINIMAL_DATAFILE),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_custom',
      cdnHost: 'https://custom.example.com',
      autoRefresh: false,
    })

    await client.onReady()

    const datafileCall = fetchMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && String(call[0]).includes('datafile.json')
    )
    expect(datafileCall?.[0]).toBe(
      'https://custom.example.com/sdk_custom/datafile.json'
    )

    client.close()
  })

  it('strips a trailing slash from a custom cdnHost', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MINIMAL_DATAFILE),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_slash',
      cdnHost: 'https://custom.example.com/',
      autoRefresh: false,
    })

    await client.onReady()

    const datafileCall = fetchMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && String(call[0]).includes('datafile.json')
    )
    expect(datafileCall?.[0]).toBe(
      'https://custom.example.com/sdk_slash/datafile.json'
    )

    client.close()
  })
})

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

describe('AvsbClient — heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('sends heartbeat after successful datafile fetch', async () => {
    const heartbeatUrl = 'http://localhost:3000/api/sdk/heartbeat'
    const datafile = createBootstrapDatafile({
      heartbeatEndpoint: heartbeatUrl,
    })

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('datafile.json')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(datafile),
        })
      }
      return Promise.resolve({ ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      autoRefresh: false,
    })

    await client.onReady()

    const heartbeatCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => call[0] === heartbeatUrl
    )
    expect(heartbeatCalls.length).toBe(1)

    const heartbeatOptions = heartbeatCalls[0][1] as RequestInit
    expect(heartbeatOptions.method).toBe('POST')
    const sentBody = JSON.parse(heartbeatOptions.body as string) as Record<string, unknown>
    expect(sentBody.sdkKey).toBe('sdk_test_123')
    expect(sentBody.sdkType).toBe('@avsbhq/browser')

    client.close()
  })

  it('does not send heartbeat when heartbeatEndpoint is missing', async () => {
    const datafile = createBootstrapDatafile()
    // Ensure no heartbeatEndpoint.
    const { heartbeatEndpoint: _removed, ...datafileNoHb } = datafile as FlagDatafile & { heartbeatEndpoint?: string }
    void _removed

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('datafile.json')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(datafileNoHb),
        })
      }
      return Promise.resolve({ ok: true })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      autoRefresh: false,
    })

    await client.onReady()

    // Only the datafile fetch should have been called, no heartbeat.
    const allCalls = fetchMock.mock.calls
    const nonDatafileCalls = allCalls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' && !String(call[0]).includes('datafile.json')
    )
    expect(nonDatafileCalls.length).toBe(0)

    client.close()
  })

  it('heartbeat failure does not affect client behavior', async () => {
    const heartbeatUrl = 'http://localhost:3000/api/sdk/heartbeat'
    const datafile = createBootstrapDatafile({
      heartbeatEndpoint: heartbeatUrl,
    })

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('datafile.json')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(datafile),
        })
      }
      return Promise.reject(new Error('Network error'))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      autoRefresh: false,
    })

    await client.onReady()

    // Client should still work despite heartbeat failure.
    const flag = client.getFlag('test_flag', false)
    expect(flag.value).toBe(true)

    const allFlags = client.getAllFlags()
    expect(allFlags['test_flag']?.value).toBe(true)

    client.close()
  })
})

// ---------------------------------------------------------------------------
// getAllFlags exposure suppression (spec §5.7)
// ---------------------------------------------------------------------------

describe('AvsbClient.getAllFlags — exposure suppression', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not fire exposures by default during bulk read', async () => {
    const datafile = createBootstrapDatafile()
    const { tracker } = makeTrackerSpy()
    const queueSpy = tracker.queue as ReturnType<typeof vi.fn>
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      bootstrap: datafile,
      autoRefresh: false,
    })
    await client.onReady()

    client.getAllFlags()
    expect(queueSpy).not.toHaveBeenCalled()

    await client.close()
  })

  it('returns Flag objects with correct values', async () => {
    const datafile = createBootstrapDatafile()
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      bootstrap: datafile,
      autoRefresh: false,
    })
    await client.onReady()

    const allFlags = client.getAllFlags({ fireExposures: true })
    expect(allFlags).toHaveProperty('test_flag')
    expect(allFlags['test_flag']?.value).toBe(true)

    await client.close()
  })

  it('returns consistent values regardless of exposure setting', async () => {
    const datafile = createBootstrapDatafile()
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      bootstrap: datafile,
      autoRefresh: false,
    })
    await client.onReady()

    const silent = client.getAllFlags()
    const loud = client.getAllFlags({ fireExposures: true })

    // Values should match; compare via .value since Flag objects differ by evaluatedAt.
    expect(silent['test_flag']?.value).toEqual(loud['test_flag']?.value)
    await client.close()
  })
})

// ---------------------------------------------------------------------------
// Async close() flushes events (spec §5.20)
// ---------------------------------------------------------------------------

describe('AvsbClient.close — async + flush', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('close() returns a Promise that resolves after tracker drains', async () => {
    const datafile = createBootstrapDatafile()
    const { tracker } = makeTrackerSpy()
    const destroySpy = tracker.destroy as ReturnType<typeof vi.fn>
    destroySpy.mockResolvedValue(undefined)
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      bootstrap: datafile,
      autoRefresh: false,
    })
    await client.onReady()

    const result = client.close()
    expect(result).toBeInstanceOf(Promise)
    await result
    expect(destroySpy).toHaveBeenCalledTimes(1)
  })

  it('explicit flush() drains queued events without closing the client', async () => {
    const datafile = createBootstrapDatafile()
    const { tracker } = makeTrackerSpy()
    const flushSpy = tracker.flush as ReturnType<typeof vi.fn>
    flushSpy.mockResolvedValue(undefined)
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      bootstrap: datafile,
      autoRefresh: false,
    })
    await client.onReady()

    await client.flush()
    expect(flushSpy).toHaveBeenCalledTimes(1)
    // Client remains usable after flush.
    expect(client.getFlag('test_flag', false).value).toBe(true)

    await client.close()
  })

  it('flush() before tracker init is a no-op (no events queued yet)', async () => {
    // The only client in this file built with no bootstrap, no `autoInit:
    // false` and no fetch double, so the default autoInit put a real request
    // on the wire to the PRODUCTION CDN,
    // https://cdn.avsb.cloud/sdk_test_123/datafile.json, and it was still in
    // flight when the file ended: the one stray AbortError left in
    // `vitest run packages/`. The assertion is unchanged either way, because
    // `flush()` reads `this.tracker` synchronously and init cannot have
    // reached the tracker by then, whether the datafile 404s (what the real
    // CDN answers for this key) or arrives.
    mockFetchWithDatafile()
    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      autoRefresh: false,
    })

    await expect(client.flush()).resolves.toBeUndefined()

    // Init completes while the assertion above awaits, so close the client the
    // way every other test in this describe does: otherwise its tracker keeps
    // a flush timer armed for the rest of the file.
    await client.close()
  })
})

// ---------------------------------------------------------------------------
// updateAttributes emits flag changes (§5.2 — replaces old setAttributes test)
// ---------------------------------------------------------------------------

describe('AvsbClient.updateAttributes — change emission', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('fires onFlagChange callbacks when an attribute change flips a flag value', async () => {
    const datafile: FlagDatafile = createBootstrapDatafile({
      audiences: [{
        id: 'aud-1',
        rules: {
          id: 'group-1', logic: 'AND',
          conditions: [{
            id: 'c-1', type: 'CUSTOM_ATTRIBUTE',
            attribute: 'plan', operator: 'equals', value: 'pro',
          }],
        },
      }],
      flags: [{
        id: 'flag1', key: 'pro_feature', type: 'boolean',
        enabled: true, defaultVariationId: 'var_off',
        variations: [
          { id: 'var_off', key: 'off', value: false },
          { id: 'var_on', key: 'on', value: true },
        ],
        overrides: [],
        rules: [{
          id: 'rule1', type: 'targeted_delivery', enabled: true,
          audienceIds: ['aud-1'], hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var_on', percentage: 1 }],
        }],
      }],
    })

    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1', plan: 'free' },
      bootstrap: datafile,
      autoRefresh: false,
    })
    await client.onReady()

    const changeSpy = vi.fn()
    client.onFlagChange(changeSpy)

    // pro_feature evaluates to false for free plan, true for pro plan.
    client.updateAttributes({ plan: 'pro' })

    expect(changeSpy).toHaveBeenCalledTimes(1)
    expect(changeSpy.mock.calls[0][0]).toBe('pro_feature')
    expect(changeSpy.mock.calls[0][1]).toBe(true)
    expect(changeSpy.mock.calls[0][2]).toBe(false)

    await client.close()
  })

  it('does not fire change callbacks when no flag values flip', async () => {
    const datafile = createBootstrapDatafile()
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      bootstrap: datafile,
      autoRefresh: false,
    })
    await client.onReady()

    const changeSpy = vi.fn()
    client.onFlagChange(changeSpy)

    // No flag in the bootstrap depends on `country`, so the flip is irrelevant.
    client.updateAttributes({ country: 'US' })

    expect(changeSpy).not.toHaveBeenCalled()
    await client.close()
  })

  it('unsubscribe removes the callback', async () => {
    const datafile = createBootstrapDatafile()
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_test_123',
      context: { kind: 'user', key: 'user-1' },
      bootstrap: datafile,
      autoRefresh: false,
    })
    await client.onReady()

    const changeSpy = vi.fn()
    const off = client.onFlagChange(changeSpy)
    off()
    client.updateAttributes({ userId: 'user-2' })

    expect(changeSpy).not.toHaveBeenCalled()
    await client.close()
  })
})
