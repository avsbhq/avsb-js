/**
 * Tests for §5.9 Override split:
 *   setOverrideForUser(), setGlobalOverride(),
 *   clearOverrideForUser(), clearGlobalOverride(), clearAllOverrides()
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AvsbClient } from './AvsbClient'
import type { FlagDatafile, Tracker } from './types'
import * as trackerModule from './tracker'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DATAFILE: FlagDatafile = {
  version: 1,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk_overrides_test',
  environmentKey: 'production',
  publishedAt: '2025-01-01T00:00:00Z',
  collectEndpoint: 'http://localhost:3001',
  audiences: [],
  flags: [
    {
      id: 'f1', key: 'my_flag', type: 'boolean',
      enabled: true, defaultVariationId: 'voff',
      variations: [
        { id: 'voff', key: 'off', value: false },
        { id: 'von', key: 'on', value: true },
      ],
      overrides: [],
      rules: [],
    },
    {
      id: 'f2', key: 'plan_flag', type: 'string',
      enabled: true, defaultVariationId: 'v_free',
      variations: [
        { id: 'v_free', key: 'free', value: 'free' },
        { id: 'v_pro', key: 'pro', value: 'pro' },
      ],
      overrides: [],
      rules: [],
    },
  ],
}

function makeTrackerSpy(): Tracker {
  return {
    queue: vi.fn(),
    queueMetric: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
}

function createClient(contextKey: string = 'u1'): AvsbClient {
  const tracker = makeTrackerSpy()
  vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)

  return new AvsbClient({
    sdkKey: 'sdk_overrides_test',
    bootstrap: DATAFILE,
    autoRefresh: false,
    context: { kind: 'user', key: contextKey },
  })
}

// ---------------------------------------------------------------------------
// setGlobalOverride
// ---------------------------------------------------------------------------

describe('AvsbClient.setGlobalOverride()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('forces the flag to the specified variation for all contexts', () => {
    const client = createClient('any-user')
    client.setGlobalOverride('my_flag', 'on')

    const flag = client.getFlag('my_flag', false)
    expect(flag.value).toBe(true)
    expect(flag.source).toBe('runtimeOverride')
  })

  it('override is reflected in getAllFlags()', () => {
    const client = createClient('any-user')
    client.setGlobalOverride('plan_flag', 'pro')

    const flags = client.getAllFlags()
    expect(flags['plan_flag']?.value).toBe('pro')
    expect(flags['plan_flag']?.source).toBe('runtimeOverride')
  })

  it('global override takes precedence over default evaluation', () => {
    // Without override the flag would return default (no rules).
    const client = createClient('any-user')
    const beforeFlag = client.getFlag('my_flag', false)
    // No rules → default variation → false.
    expect(beforeFlag.value).toBe(false)

    client.setGlobalOverride('my_flag', 'on')

    const afterFlag = client.getFlag('my_flag', false)
    expect(afterFlag.value).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// setOverrideForUser
// ---------------------------------------------------------------------------

describe('AvsbClient.setOverrideForUser()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('applies the override only for the specified context key', () => {
    const client = createClient('target-user')
    client.setOverrideForUser('my_flag', 'target-user', 'on')

    const flagForTarget = client.getFlag('my_flag', false)
    expect(flagForTarget.value).toBe(true)
    expect(flagForTarget.source).toBe('runtimeOverride')
  })

  it('does not apply to a different context key', () => {
    const client = createClient('other-user')
    // Override is for 'target-user', not 'other-user'.
    client.setOverrideForUser('my_flag', 'target-user', 'on')

    const flag = client.getFlag('my_flag', false)
    // Should not apply — other-user gets the default.
    expect(flag.source).not.toBe('runtimeOverride')
  })

  it('defaults contextKind to user when not specified', () => {
    const client = createClient('u1')
    // No contextKind → defaults to 'user'.
    client.setOverrideForUser('my_flag', 'u1', 'on')

    const flag = client.getFlag('my_flag', false)
    expect(flag.value).toBe(true)
    expect(flag.source).toBe('runtimeOverride')
  })

  it('per-context override takes precedence over global override for that context', () => {
    const client = createClient('special-user')
    // Global says 'off', per-context says 'on'.
    client.setGlobalOverride('my_flag', 'off')
    client.setOverrideForUser('my_flag', 'special-user', 'on')

    const flag = client.getFlag('my_flag', false)
    expect(flag.value).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// clearOverrideForUser
// ---------------------------------------------------------------------------

describe('AvsbClient.clearOverrideForUser()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('removes the per-user override so evaluation falls through', () => {
    const client = createClient('u1')
    client.setOverrideForUser('my_flag', 'u1', 'on')
    client.clearOverrideForUser('my_flag', 'u1')

    const flag = client.getFlag('my_flag', false)
    // No rules → default variation (off).
    expect(flag.source).not.toBe('runtimeOverride')
    expect(flag.value).toBe(false)
  })

  it('clearing a nonexistent override is a no-op', () => {
    const client = createClient('u1')
    expect(() => client.clearOverrideForUser('my_flag', 'ghost-user')).not.toThrow()
  })

  it('clearing one user override does not affect another user override', () => {
    // Both u1 and u2 get overrides; clear only u1.
    const client = createClient('u2')
    client.setOverrideForUser('my_flag', 'u1', 'on')
    client.setOverrideForUser('my_flag', 'u2', 'on')
    client.clearOverrideForUser('my_flag', 'u1')

    // Current context is u2 — its override should still apply.
    const flag = client.getFlag('my_flag', false)
    expect(flag.source).toBe('runtimeOverride')
    expect(flag.value).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// clearGlobalOverride
// ---------------------------------------------------------------------------

describe('AvsbClient.clearGlobalOverride()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('removes the global override so evaluation falls through', () => {
    const client = createClient('u1')
    client.setGlobalOverride('my_flag', 'on')
    client.clearGlobalOverride('my_flag')

    const flag = client.getFlag('my_flag', false)
    expect(flag.source).not.toBe('runtimeOverride')
  })

  it('does not affect per-context overrides', () => {
    const client = createClient('u1')
    client.setGlobalOverride('my_flag', 'off')
    client.setOverrideForUser('my_flag', 'u1', 'on')
    client.clearGlobalOverride('my_flag')

    // Per-context override still applies.
    const flag = client.getFlag('my_flag', false)
    expect(flag.value).toBe(true)
    expect(flag.source).toBe('runtimeOverride')
  })
})

// ---------------------------------------------------------------------------
// clearAllOverrides
// ---------------------------------------------------------------------------

describe('AvsbClient.clearAllOverrides()', () => {
  afterEach(() => vi.restoreAllMocks())

  it('removes all global and per-context overrides', () => {
    const client = createClient('u1')
    client.setGlobalOverride('my_flag', 'on')
    client.setOverrideForUser('my_flag', 'u1', 'on')
    client.setGlobalOverride('plan_flag', 'pro')
    client.clearAllOverrides()

    const flag = client.getFlag('my_flag', false)
    expect(flag.source).not.toBe('runtimeOverride')

    const planFlag = client.getFlag('plan_flag', 'free')
    expect(planFlag.source).not.toBe('runtimeOverride')
  })

  it('is a no-op when no overrides exist', () => {
    const client = createClient('u1')
    expect(() => client.clearAllOverrides()).not.toThrow()
  })

  it('triggers flag change callbacks when removing an active override flips a value', () => {
    const client = createClient('u1')
    client.setGlobalOverride('my_flag', 'on')
    // At this point, my_flag = true (overridden).

    const changeSpy = vi.fn()
    client.onFlagChange(changeSpy)

    client.clearAllOverrides()
    // my_flag drops back to false (no rules, default variation = off).
    expect(changeSpy).toHaveBeenCalledTimes(1)
    expect(changeSpy.mock.calls[0][0]).toBe('my_flag')
    expect(changeSpy.mock.calls[0][1]).toBe(false)
    expect(changeSpy.mock.calls[0][2]).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// runtimeOverride in getAllFlags
// ---------------------------------------------------------------------------

describe('getAllFlags with overrides', () => {
  afterEach(() => vi.restoreAllMocks())

  it('overridden flags appear in getAllFlags with source=runtimeOverride', () => {
    const client = createClient('u1')
    client.setGlobalOverride('my_flag', 'on')

    const flags = client.getAllFlags()
    expect(flags['my_flag']?.source).toBe('runtimeOverride')
    expect(flags['my_flag']?.value).toBe(true)
  })

  it('non-overridden flags appear with their normal source', () => {
    const client = createClient('u1')
    client.setGlobalOverride('my_flag', 'on')

    const flags = client.getAllFlags()
    // plan_flag has no override.
    expect(flags['plan_flag']?.source).not.toBe('runtimeOverride')
  })
})
