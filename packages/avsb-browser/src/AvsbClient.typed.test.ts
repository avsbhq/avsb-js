/**
 * Tests for §5.11 Typed evaluator variants and §5.14-adjacent getSnapshot:
 *   getBoolFlag(), getStringFlag(), getNumberFlag(), getJsonFlag(),
 *   getFlag(), getSnapshot()
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AvsbClient } from './AvsbClient'
import type { FlagDatafile, Tracker } from './types'
import * as trackerModule from './tracker'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTrackerSpy(): Tracker {
  return {
    queue: vi.fn(),
    queueMetric: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
}

/** One flag per declared type in the datafile. */
function createTypedDatafile(): FlagDatafile {
  return {
    version: 1,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'sdk_typed_test',
    environmentKey: 'production',
    publishedAt: '2025-01-01T00:00:00Z',
    collectEndpoint: 'http://localhost:3001',
    audiences: [],
    flags: [
      {
        id: 'b1', key: 'bool_flag', type: 'boolean',
        enabled: true, defaultVariationId: 'bv_off',
        variations: [
          { id: 'bv_off', key: 'off', value: false },
          { id: 'bv_on', key: 'on', value: true },
        ],
        overrides: [],
        rules: [{
          id: 'br1', type: 'targeted_delivery', enabled: true,
          audienceIds: [], hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'bv_on', percentage: 1 }],
        }],
      },
      {
        id: 's1', key: 'str_flag', type: 'string',
        enabled: true, defaultVariationId: 'sv_a',
        variations: [
          { id: 'sv_a', key: 'control', value: 'hello' },
          { id: 'sv_b', key: 'treatment', value: 'world' },
        ],
        overrides: [],
        rules: [{
          id: 'sr1', type: 'targeted_delivery', enabled: true,
          audienceIds: [], hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'sv_b', percentage: 1 }],
        }],
      },
      {
        id: 'n1', key: 'num_flag', type: 'number',
        enabled: true, defaultVariationId: 'nv_0',
        variations: [
          { id: 'nv_0', key: 'zero', value: 0 },
          { id: 'nv_42', key: 'answer', value: 42 },
        ],
        overrides: [],
        rules: [{
          id: 'nr1', type: 'targeted_delivery', enabled: true,
          audienceIds: [], hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'nv_42', percentage: 1 }],
        }],
      },
      {
        id: 'j1', key: 'json_flag', type: 'json',
        enabled: true, defaultVariationId: 'jv_empty',
        variations: [
          { id: 'jv_empty', key: 'empty', value: {} },
          { id: 'jv_config', key: 'config', value: { theme: 'dark', rows: 10 } },
        ],
        overrides: [],
        rules: [{
          id: 'jr1', type: 'targeted_delivery', enabled: true,
          audienceIds: [], hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'jv_config', percentage: 1 }],
        }],
      },
      // A boolean flag that will be queried as string to test type mismatch.
      {
        id: 'm1', key: 'mismatch_flag', type: 'boolean',
        enabled: true, defaultVariationId: 'mv_on',
        variations: [
          { id: 'mv_on', key: 'on', value: true },
        ],
        overrides: [],
        rules: [],
      },
    ],
  }
}

function createBootstrapClient(): AvsbClient {
  const tracker = makeTrackerSpy()
  vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

  return new AvsbClient({
    sdkKey: 'sdk_typed_test',
    bootstrap: createTypedDatafile(),
    autoRefresh: false,
    context: { kind: 'user', key: 'typed-user' },
  })
}

// ---------------------------------------------------------------------------
// getBoolFlag
// ---------------------------------------------------------------------------

describe('AvsbClient.getBoolFlag()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns a Flag<boolean> with the resolved value', () => {
    const client = createBootstrapClient()
    const flag = client.getBoolFlag('bool_flag', false)
    expect(flag.value).toBe(true)
    expect(flag.source).not.toBe('not_found')
  })

  it('returns the default wrapped in a Flag when flag is not found', () => {
    const client = createBootstrapClient()
    const flag = client.getBoolFlag('nonexistent', false)
    expect(flag.value).toBe(false)
    expect(flag.source).toBe('not_found')
  })

  it('returns default and logs warning on type mismatch (flag declared as boolean, queried as string)', () => {
    const warnSpy = vi.fn()
    const client = new AvsbClient({
      sdkKey: 'sdk_typed_test',
      bootstrap: createTypedDatafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'typed-user' },
      logger: {
        debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn(),
        child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => ({} as import('@avsbhq/core').Logger) }) }),
      },
    })

    // getBoolFlag on a flag that exists as boolean but its value is non-boolean
    // We simulate this by requesting a flag whose datafile type is 'boolean' — no mismatch.
    // Instead test the opposite: request 'mismatch_flag' (boolean) as a string.
    const flag = client.getStringFlag('mismatch_flag', 'fallback')
    // The flag is declared boolean in datafile but requested as string → type mismatch.
    expect(flag.value).toBe('fallback')
    expect(warnSpy).toHaveBeenCalledOnce()
    // The message names the getter, the declared type, and what to do instead.
    const warning = String(warnSpy.mock.calls[0][0])
    expect(warning).toContain('string getter')
    expect(warning).toContain('declared as "boolean"')
    expect(warning).toContain('the default was returned')
  })
})

// ---------------------------------------------------------------------------
// getStringFlag
// ---------------------------------------------------------------------------

describe('AvsbClient.getStringFlag()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns a Flag<string> with the resolved value', () => {
    const client = createBootstrapClient()
    const flag = client.getStringFlag('str_flag', 'default')
    expect(flag.value).toBe('world')
    expect(typeof flag.value).toBe('string')
  })

  it('returns the default when flag is not found', () => {
    const client = createBootstrapClient()
    const flag = client.getStringFlag('missing', 'fallback')
    expect(flag.value).toBe('fallback')
    expect(flag.source).toBe('not_found')
  })

  it('carries variationKey and ruleId on a matched rule', () => {
    const client = createBootstrapClient()
    const flag = client.getStringFlag('str_flag', 'default')
    expect(flag.variationKey).toBe('treatment')
    expect(flag.ruleId).toBe('sr1')
  })
})

// ---------------------------------------------------------------------------
// getNumberFlag
// ---------------------------------------------------------------------------

describe('AvsbClient.getNumberFlag()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns a Flag<number> with the resolved value', () => {
    const client = createBootstrapClient()
    const flag = client.getNumberFlag('num_flag', 0)
    expect(flag.value).toBe(42)
    expect(typeof flag.value).toBe('number')
  })

  it('returns the default when flag is not found', () => {
    const client = createBootstrapClient()
    const flag = client.getNumberFlag('missing', -1)
    expect(flag.value).toBe(-1)
    expect(flag.source).toBe('not_found')
  })

  it('isEnabled() returns true when a rule matched and value is truthy', () => {
    const client = createBootstrapClient()
    const flag = client.getNumberFlag('num_flag', 0)
    // value = 42 (truthy), source = 'rule'
    expect(flag.isEnabled()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// getJsonFlag
// ---------------------------------------------------------------------------

describe('AvsbClient.getJsonFlag()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns a typed Flag<T> for a json flag', () => {
    const client = createBootstrapClient()
    const flag = client.getJsonFlag<{ theme: string; rows: number }>(
      'json_flag',
      { theme: 'light', rows: 5 }
    )
    expect(flag.value).toEqual({ theme: 'dark', rows: 10 })
  })

  it('returns the default value when flag is not found', () => {
    const client = createBootstrapClient()
    const dflt = { mode: 'off' }
    const flag = client.getJsonFlag('missing_json', dflt)
    expect(flag.value).toEqual(dflt)
    expect(flag.source).toBe('not_found')
  })

  it('returns the default with source not_ready before the datafile loads', () => {
    // No bootstrap and `autoInit: false`, so nothing is loaded and nothing is
    // fetched. B15: a pre-ready read reports not_ready, not not_found, and the
    // typed getters keep that source instead of running their type check
    // against a datafile that is not there.
    const client = new AvsbClient({
      sdkKey: 'sdk_typed_test',
      autoRefresh: false,
      autoInit: false,
      context: { kind: 'user', key: 'u1' },
    })
    const flag = client.getJsonFlag('json_flag', { fallback: true })
    expect(flag.value).toEqual({ fallback: true })
    expect(flag.source).toBe('not_ready')
  })
})

// ---------------------------------------------------------------------------
// getFlag — generic variant
// ---------------------------------------------------------------------------

describe('AvsbClient.getFlag()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns Flag<T> with value, source, ruleId populated', () => {
    const client = createBootstrapClient()
    const flag = client.getFlag('bool_flag', false)
    expect(flag.value).toBe(true)
    expect(flag.source).toBe('rule')
    expect(flag.ruleId).toBe('br1')
  })

  it('returns Flag<T> with source not_found when flag key is absent', () => {
    const client = createBootstrapClient()
    const flag = client.getFlag('phantom', 'default')
    expect(flag.value).toBe('default')
    expect(flag.source).toBe('not_found')
    expect(flag.exists()).toBe(false)
  })

  it('Flag.isEnabled() is false for default/not_found sources', () => {
    const client = createBootstrapClient()
    const flag = client.getFlag('phantom', false)
    expect(flag.isEnabled()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getSnapshot (§5.14)
// ---------------------------------------------------------------------------

describe('AvsbClient.getSnapshot()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns a Flag<T> synchronously without firing an exposure', () => {
    const tracker = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

    const client = new AvsbClient({
      sdkKey: 'sdk_typed_test',
      bootstrap: createTypedDatafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'typed-user' },
    })

    const flag = client.getSnapshot('bool_flag', false)
    expect(flag.value).toBe(true)
    // No exposure should have been queued.
    const queueSpy = tracker.queue as ReturnType<typeof vi.fn>
    expect(queueSpy).not.toHaveBeenCalled()
  })

  it('returns the default with source not_ready before the datafile loads', () => {
    // Breaking change B15: "you asked too early" and "that flag does not
    // exist" are different problems and used to report the same source.
    // `autoInit: false` keeps this test off the network.
    const client = new AvsbClient({
      sdkKey: 'sdk_typed_test',
      autoRefresh: false,
      autoInit: false,
      context: { kind: 'user', key: 'u1' },
    })

    const flag = client.getSnapshot('bool_flag', false)
    expect(flag.value).toBe(false)
    expect(flag.source).toBe('not_ready')
    expect(flag.exists()).toBe(false)
  })

  it('reflects identify() changes on subsequent calls', () => {
    const datafile: FlagDatafile = {
      ...createTypedDatafile(),
      flags: [{
        id: 'f1', key: 'user_flag', type: 'boolean',
        enabled: true, defaultVariationId: 'voff',
        variations: [
          { id: 'voff', key: 'off', value: false },
          { id: 'von', key: 'on', value: true },
        ],
        overrides: [{ userId: 'identified-user', variationId: 'von' }],
        rules: [],
      }],
    }

    const client = new AvsbClient({
      sdkKey: 'sdk_typed_test',
      bootstrap: datafile,
      autoRefresh: false,
      context: { kind: 'user', key: 'anon-user' },
    })

    const before = client.getSnapshot('user_flag', false)
    expect(before.value).toBe(false)

    client.identify({ kind: 'user', key: 'identified-user' })

    const after = client.getSnapshot('user_flag', false)
    expect(after.value).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// subscribe (§5.14)
// ---------------------------------------------------------------------------

describe('AvsbClient.subscribe()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('notifies subscriber when flag value changes', () => {
    const datafile: FlagDatafile = {
      version: 1,
      projectType: 'FEATURE_FLAG',
      sdkKey: 'sdk_typed_test',
      environmentKey: 'production',
      publishedAt: '2025-01-01T00:00:00Z',
      collectEndpoint: 'http://localhost:3001',
      audiences: [{
        id: 'aud-1',
        rules: {
          id: 'g1', logic: 'AND',
          conditions: [{
            id: 'c1', type: 'CUSTOM_ATTRIBUTE',
            attribute: 'plan', operator: 'equals', value: 'pro',
          }],
        },
      }],
      flags: [{
        id: 'f1', key: 'feature', type: 'boolean',
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
      sdkKey: 'sdk_typed_test',
      bootstrap: datafile,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'free' },
    })

    const listener = vi.fn()
    client.subscribe('feature', listener)

    client.updateAttributes({ plan: 'pro' })

    expect(listener).toHaveBeenCalledOnce()
  })

  it('unsubscribe removes the listener', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_typed_test',
      bootstrap: createTypedDatafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    const listener = vi.fn()
    const unsubscribe = client.subscribe('bool_flag', listener)
    unsubscribe()

    client.identify({ kind: 'user', key: 'u2' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('multiple subscribers for the same flag are all notified', () => {
    const datafile: FlagDatafile = {
      version: 1,
      projectType: 'FEATURE_FLAG',
      sdkKey: 'sdk_typed_test',
      environmentKey: 'production',
      publishedAt: '2025-01-01T00:00:00Z',
      collectEndpoint: 'http://localhost:3001',
      audiences: [],
      flags: [{
        id: 'f1', key: 'multi_sub', type: 'boolean',
        enabled: true, defaultVariationId: 'voff',
        variations: [
          { id: 'voff', key: 'off', value: false },
          { id: 'von', key: 'on', value: true },
        ],
        overrides: [{ userId: 'new-user', variationId: 'von' }],
        rules: [],
      }],
    }

    const client = new AvsbClient({
      sdkKey: 'sdk_typed_test',
      bootstrap: datafile,
      autoRefresh: false,
      context: { kind: 'user', key: 'old-user' },
    })

    const l1 = vi.fn()
    const l2 = vi.fn()
    client.subscribe('multi_sub', l1)
    client.subscribe('multi_sub', l2)

    client.identify({ kind: 'user', key: 'new-user' })

    expect(l1).toHaveBeenCalledOnce()
    expect(l2).toHaveBeenCalledOnce()
  })
})
