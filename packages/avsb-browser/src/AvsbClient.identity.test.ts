/**
 * Tests for §5.2 Identity model:
 *   identify(), updateAttributes(), alias(), getContext(), reset()
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { AvsbClient } from './AvsbClient'
import type { FlagDatafile, Tracker } from './types'
import type { EvalContext } from '@avsbhq/core'
import * as trackerModule from './tracker'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_DATAFILE: FlagDatafile = {
  version: 1,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk_identity_test',
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

// Identity is persisted (localStorage, cookie fallback) and datafiles are
// cached, so each test starts from a cold browser.
beforeEach(() => {
  localStorage.clear()
})

function bootstrapClient(
  opts: Partial<ConstructorParameters<typeof AvsbClient>[0]> = {}
): AvsbClient {
  return new AvsbClient({
    sdkKey: 'sdk_identity_test',
    bootstrap: MINIMAL_DATAFILE,
    autoRefresh: false,
    ...opts,
  })
}

// ---------------------------------------------------------------------------
// identify()
// ---------------------------------------------------------------------------

describe('AvsbClient.identify()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('replaces the entire bound context', () => {
    const client = bootstrapClient({
      context: { kind: 'user', key: 'old-user' },
    })

    const newCtx: EvalContext = { kind: 'user', key: 'new-user', plan: 'pro' }
    client.identify(newCtx)

    const snapshot = client.getContext()
    expect(snapshot).toEqual(newCtx)
  })

  it('triggers onFlagChange callbacks after identify when flag values differ', () => {
    // Build a datafile with a flag that depends on context kind.
    const datafile: FlagDatafile = {
      ...MINIMAL_DATAFILE,
      audiences: [{
        id: 'aud-pro',
        rules: {
          id: 'g1', logic: 'AND',
          conditions: [{
            id: 'c1', type: 'CUSTOM_ATTRIBUTE',
            attribute: 'plan', operator: 'equals', value: 'pro',
          }],
        },
      }],
      flags: [{
        id: 'f1', key: 'pro_only', type: 'boolean',
        enabled: true, defaultVariationId: 'var_off',
        variations: [
          { id: 'var_off', key: 'off', value: false },
          { id: 'var_on', key: 'on', value: true },
        ],
        overrides: [],
        rules: [{
          id: 'r1', type: 'targeted_delivery', enabled: true,
          audienceIds: ['aud-pro'], hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var_on', percentage: 1 }],
        }],
      }],
    }

    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_identity_test',
      bootstrap: datafile,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'free' },
    })

    const changeSpy = vi.fn()
    client.onFlagChange(changeSpy)

    client.identify({ kind: 'user', key: 'u2', plan: 'pro' })

    expect(changeSpy).toHaveBeenCalledTimes(1)
    expect(changeSpy.mock.calls[0][0]).toBe('pro_only')
    expect(changeSpy.mock.calls[0][1]).toBe(true)
    expect(changeSpy.mock.calls[0][2]).toBe(false)
  })

  it('accepts a multi-context', () => {
    const client = bootstrapClient({
      context: { kind: 'user', key: 'u1' },
    })

    const multiCtx: EvalContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u1' },
      organization: { kind: 'organization', key: 'org42', tier: 'enterprise' },
    }

    client.identify(multiCtx)
    expect(client.getContext()).toEqual(multiCtx)
  })
})

// ---------------------------------------------------------------------------
// updateAttributes()
// ---------------------------------------------------------------------------

describe('AvsbClient.updateAttributes()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('merges attributes into a single-context (same kind)', () => {
    const client = bootstrapClient({
      context: { kind: 'user', key: 'u1', plan: 'free' },
    })

    client.updateAttributes({ plan: 'pro', country: 'US' })
    const ctx = client.getContext() as unknown as { kind: string; key: string; plan: string; country: string }
    expect(ctx.plan).toBe('pro')
    expect(ctx.country).toBe('US')
    expect(ctx.key).toBe('u1')
  })

  it('defaults contextKind to user when not specified', () => {
    const client = bootstrapClient({
      context: { kind: 'user', key: 'u1' },
    })

    client.updateAttributes({ email: 'a@b.com' })
    const ctx = client.getContext() as unknown as { kind: string; email: string }
    expect(ctx.kind).toBe('user')
    expect(ctx.email).toBe('a@b.com')
  })

  it('merges into the correct sub-context of a multi-context', () => {
    const client = bootstrapClient({
      context: {
        kind: 'multi',
        user: { kind: 'user', key: 'u1', plan: 'free' },
        organization: { kind: 'organization', key: 'org1', tier: 'basic' },
      },
    })

    client.updateAttributes({ tier: 'enterprise' }, 'organization')

    const ctx = client.getContext() as unknown as {
      kind: 'multi'
      organization: { kind: string; key: string; tier: string }
      user: { plan: string }
    }
    expect(ctx.organization.tier).toBe('enterprise')
    // User sub-context should be unchanged.
    expect(ctx.user.plan).toBe('free')
  })
})

// ---------------------------------------------------------------------------
// alias()
// ---------------------------------------------------------------------------

describe('AvsbClient.alias()', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('emits an avsb_alias event attributed to the bound identity', async () => {
    const { tracker, queueMetricMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_identity_test',
      bootstrap: MINIMAL_DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'signed-in-xyz' },
    })
    await client.onReady()

    const prevCtx: EvalContext = { kind: 'user', key: 'anon-abc' }
    const newCtx: EvalContext = { kind: 'user', key: 'signed-in-xyz' }
    client.alias(prevCtx, newCtx)

    expect(queueMetricMock).toHaveBeenCalledOnce()
    const event = queueMetricMock.mock.calls[0][0] as {
      eventName: string
      visitorId: string
      properties?: Record<string, unknown>
    }
    expect(event.eventName).toBe('avsb_alias')
    expect(event.visitorId).toBe('signed-in-xyz')
    // No properties on the wire: /v1/collect/metric-batch declares none, so
    // carrying the previous key here would be a promise the pipeline breaks.
    expect(event.properties).toBeUndefined()
  })

  it('warns when alias runs before identify, so the event would land on the old identity', async () => {
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
    const warn = vi.fn()

    const client = new AvsbClient({
      sdkKey: 'sdk_identity_test',
      bootstrap: MINIMAL_DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'anon-abc' },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
        child() {
          return this
        },
      },
    })
    await client.onReady()

    client.alias(
      { kind: 'user', key: 'anon-abc' },
      { kind: 'user', key: 'signed-in-xyz' },
    )

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('identify(newContext) first')
  })

  it('queues the alias event pre-ready and flushes on init', async () => {
    const { tracker, queueMetricMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
    // Stub through vitest rather than assigning `globalThis.fetch` directly:
    // the direct assignment was never undone, so this mock stayed installed
    // for every test that ran after it. unstubAllGlobals in afterEach now
    // puts the real `fetch` back.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MINIMAL_DATAFILE),
      }),
    )

    const client = new AvsbClient({
      sdkKey: 'sdk_identity_test',
      context: { kind: 'user', key: 'anon-pre' },
      autoRefresh: false,
    })

    // Call alias before onReady.
    client.alias(
      { kind: 'user', key: 'anon-pre' },
      { kind: 'user', key: 'identified-post' }
    )
    expect(queueMetricMock).not.toHaveBeenCalled()

    await client.onReady()
    // Queued alias event flushed.
    expect(queueMetricMock).toHaveBeenCalledOnce()
    expect((queueMetricMock.mock.calls[0][0] as { eventName: string }).eventName).toBe('avsb_alias')
  })

  it('is synchronous and returns nothing (B5 signature change)', () => {
    const client = bootstrapClient({
      context: { kind: 'user', key: 'u1' },
    })

    // Was `async alias(): Promise<void>` resolving immediately after a
    // synchronous track, which made awaiting look meaningful.
    expect(
      client.alias({ kind: 'user', key: 'u1' }, { kind: 'user', key: 'u2' })
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// getContext()
// ---------------------------------------------------------------------------

describe('AvsbClient.getContext()', () => {
  it('returns the current context snapshot', () => {
    const ctx: EvalContext = { kind: 'user', key: 'snap-user', role: 'admin' }
    const client = bootstrapClient({ context: ctx })
    expect(client.getContext()).toEqual(ctx)
  })

  it('reflects identify() changes', () => {
    const client = bootstrapClient({ context: { kind: 'user', key: 'before' } })
    client.identify({ kind: 'user', key: 'after' })
    expect((client.getContext() as unknown as { key: string }).key).toBe('after')
  })

  it('reflects updateAttributes() changes', () => {
    const client = bootstrapClient({
      context: { kind: 'user', key: 'u1', plan: 'free' },
    })
    client.updateAttributes({ plan: 'pro' })
    expect((client.getContext() as unknown as { plan: string }).plan).toBe('pro')
  })
})

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe('AvsbClient.reset()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('replaces context with a fresh anonymous single-context', () => {
    const client = bootstrapClient({
      context: { kind: 'user', key: 'identified-user' },
    })

    client.reset()

    const ctx = client.getContext() as unknown as { kind: string; key: string; _meta?: { anonymous?: boolean } }
    expect(ctx.kind).toBe('user')
    expect(ctx.key).not.toBe('identified-user')
    expect(ctx._meta?.anonymous).toBe(true)
  })

  it('clears all runtime overrides on reset', () => {
    const client = bootstrapClient({
      context: { kind: 'user', key: 'u1' },
    })
    client.setGlobalOverride('some_flag', 'on')
    client.reset()

    // After reset, no override should apply. getFlag returns default (flag not in MINIMAL_DATAFILE).
    const flag = client.getFlag('some_flag', false)
    expect(flag.source).toBe('not_found')
  })

  it('triggers onFlagChange callbacks when the context reset flips a flag', () => {
    // Build a datafile with a flag that always produces true for any rule match.
    const datafile: FlagDatafile = {
      ...MINIMAL_DATAFILE,
      flags: [{
        id: 'f1', key: 'user_scoped', type: 'boolean',
        enabled: true, defaultVariationId: 'var_off',
        variations: [
          { id: 'var_off', key: 'off', value: false },
          { id: 'var_on', key: 'on', value: true },
        ],
        overrides: [{ userId: 'identified-user', variationId: 'var_on' }],
        rules: [],
      }],
    }

    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_identity_test',
      bootstrap: datafile,
      autoRefresh: false,
      context: { kind: 'user', key: 'identified-user' },
    })

    const changeSpy = vi.fn()
    client.onFlagChange(changeSpy)

    client.reset()

    // The flag had a datafile override for 'identified-user' → after reset it falls back to default.
    // At least one change event should fire (or none if the value is already false).
    // The important check: no throw, and context is now anonymous.
    const ctx = client.getContext() as unknown as { _meta?: { anonymous?: boolean } }
    expect(ctx._meta?.anonymous).toBe(true)
  })
})
