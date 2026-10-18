import { describe, it, expect } from 'vitest'
import { evaluateFlagServer } from './evaluateFlagServer'
import type { FlagDatafile, EvalContext } from '@avsbhq/core'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_CTX: EvalContext = { kind: 'user', key: 'user-1' }

const ORG_CTX: EvalContext = { kind: 'organization', key: 'org-99' }

const MULTI_CTX: EvalContext = {
  kind: 'multi',
  user: { kind: 'user', key: 'user-1' },
  organization: { kind: 'organization', key: 'org-99' },
}

function makeDatafile(flags: FlagDatafile['flags'] = []): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'sdk-test',
    environmentKey: 'production',
    publishedAt: '2024-01-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.test.invalid',
    flags,
    audiences: [],
  }
}

function makeFlag(key: string, overrideUserId?: string) {
  return {
    id: `flag-${key}`,
    key,
    type: 'boolean' as const,
    enabled: true,
    defaultVariationId: 'var-off',
    variations: [
      { id: 'var-on', key: 'on', value: true },
      { id: 'var-off', key: 'off', value: false },
    ],
    overrides: overrideUserId
      ? [{ userId: overrideUserId, variationId: 'var-on' }]
      : [],
    rules: [],
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateFlagServer', () => {
  it('returns not_found flag when flagKey is absent from the datafile', () => {
    const datafile = makeDatafile([])
    const flag = evaluateFlagServer(datafile, USER_CTX, 'missing-flag', false)

    expect(flag.source).toBe('not_found')
    expect(flag.value).toBe(false)
    expect(flag.variationKey).toBeNull()
  })

  it('returns the default variation value when the flag is disabled', () => {
    const disabledFlag = { ...makeFlag('my-flag'), enabled: false }
    const datafile = makeDatafile([disabledFlag])

    const flag = evaluateFlagServer(datafile, USER_CTX, 'my-flag', false)

    expect(flag.source).toBe('disabled')
    // Default variation is 'off' which has value false
    expect(flag.value).toBe(false)
  })

  it('returns a rule-served flag for a matched override', () => {
    const flagEntry = makeFlag('my-flag', 'user-1')
    const datafile = makeDatafile([flagEntry])

    const flag = evaluateFlagServer(datafile, USER_CTX, 'my-flag', false)

    // Datafile override maps to 'datafileOverride' source
    expect(flag.source).toBe('datafileOverride')
    expect(flag.value).toBe(true)
    expect(flag.variationKey).toBe('on')
  })

  it('returns the default value when no rule matches and no override', () => {
    const flagEntry = makeFlag('no-rule-flag')
    const datafile = makeDatafile([flagEntry])

    const flag = evaluateFlagServer(datafile, USER_CTX, 'no-rule-flag', 'fallback')

    // Flag found but no matching rule → default variation → source 'default'
    expect(flag.value).toBe(false) // default variation value in the fixture
    expect(['default', 'disabled']).toContain(flag.source)
  })

  it('handles a multi-context without throwing', () => {
    const flagEntry = makeFlag('multi-flag', 'user-1')
    const datafile = makeDatafile([flagEntry])

    // Should not throw; user.key='user-1' should match the override
    const flag = evaluateFlagServer(datafile, MULTI_CTX, 'multi-flag', false)

    expect(flag).toBeDefined()
    expect(typeof flag.value).toBe('boolean')
  })

  it('handles a non-user context kind without throwing', () => {
    const flagEntry = makeFlag('org-flag')
    const datafile = makeDatafile([flagEntry])

    const flag = evaluateFlagServer(datafile, ORG_CTX, 'org-flag', 'default-val')

    expect(flag).toBeDefined()
    expect(flag.source).not.toBe(undefined)
  })

  it('returns a Flag with evaluatedAt set and durationMicros of 0', () => {
    const datafile = makeDatafile([makeFlag('timing-flag')])
    const before = Date.now()
    const flag = evaluateFlagServer(datafile, USER_CTX, 'timing-flag', false)
    const after = Date.now()

    expect(flag.evaluatedAt).toBeGreaterThanOrEqual(before)
    expect(flag.evaluatedAt).toBeLessThanOrEqual(after)
    expect(flag.durationMicros).toBe(0)
  })
})
