import type { DecisionLogEntry, EvalContext } from '@avsbhq/core'
import {
  REDACTED,
  appendDecisionLogEntry,
  createDecisionLog,
  privateAttributeValues,
  redactReasons,
  redactValue,
} from './decisionLog'

function makeEntry(overrides: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
  return {
    flagKey: 'test-flag',
    value: true,
    variationKey: 'on',
    source: 'rule',
    ruleId: 'rule-1',
    ruleType: 'ab_test',
    reasons: ['matched rule'],
    evaluatedAt: Date.now(),
    durationMicros: 500,
    contextSummary: [{ kind: 'user', key: 'user-1' }],
    ...overrides,
  }
}

describe('createDecisionLog', () => {
  it('returns an object with an empty entries array', () => {
    const log = createDecisionLog()
    expect(log.entries).toEqual([])
    expect(Array.isArray(log.entries)).toBe(true)
  })

  it('creates independent logs that do not share state', () => {
    const logA = createDecisionLog()
    const logB = createDecisionLog()

    ;(logA.entries as DecisionLogEntry[]).push(makeEntry({ flagKey: 'flag-a' }))
    ;(logB.entries as DecisionLogEntry[]).push(makeEntry({ flagKey: 'flag-b' }))

    expect(logA.entries).toHaveLength(1)
    expect(logB.entries).toHaveLength(1)
    expect(logA.entries[0].flagKey).toBe('flag-a')
    expect(logB.entries[0].flagKey).toBe('flag-b')
  })

  it('accumulates multiple entries in the same log', () => {
    const log = createDecisionLog()
    for (const entry of [
      makeEntry({ flagKey: 'flag-1', source: 'rule' }),
      makeEntry({ flagKey: 'flag-2', source: 'default' }),
      makeEntry({ flagKey: 'flag-3', source: 'not_found' }),
    ]) {
      ;(log.entries as DecisionLogEntry[]).push(entry)
    }

    expect(log.entries).toHaveLength(3)
    expect(log.entries.map((e) => e.flagKey)).toEqual(['flag-1', 'flag-2', 'flag-3'])
    expect(log.entries.map((e) => e.source)).toEqual(['rule', 'default', 'not_found'])
  })
})

// The redaction the DecisionLogEntry type contract promises, which used to
// compare the flag value against private attribute NAMES and therefore only
// ever redacted the literal string "email".
describe('privateAttributeValues', () => {
  it('collects the VALUES of the attributes the context marked private', () => {
    const ctx: EvalContext = {
      kind: 'user',
      key: 'u_1',
      email: 'ada@example.com',
      plan: 'pro',
      _meta: { privateAttributes: ['email'] },
    }
    expect(privateAttributeValues(ctx)).toEqual(['ada@example.com'])
  })

  it('ignores private names the context does not actually carry', () => {
    const ctx: EvalContext = {
      kind: 'user',
      key: 'u_1',
      _meta: { privateAttributes: ['email', 'phone'] },
    }
    expect(privateAttributeValues(ctx)).toEqual([])
  })

  it('serialises non-string values so a number or object can be matched', () => {
    const ctx: EvalContext = {
      kind: 'user',
      key: 'u_1',
      age: 42,
      profile: { ssn: '000-11-2222' },
      _meta: { privateAttributes: ['age', 'profile'] },
    }
    expect(privateAttributeValues(ctx)).toEqual([
      '{"ssn":"000-11-2222"}',
      '42',
    ])
  })

  it('aggregates across every sub-context of a multi-context', () => {
    const ctx: EvalContext = {
      kind: 'multi',
      user: {
        kind: 'user',
        key: 'u_1',
        email: 'ada@example.com',
        _meta: { privateAttributes: ['email'] },
      },
      organization: {
        kind: 'organization',
        key: 'org_1',
        billingRef: 'BILL-9',
        _meta: { privateAttributes: ['billingRef'] },
      },
    }
    expect(privateAttributeValues(ctx).sort()).toEqual([
      'BILL-9',
      'ada@example.com',
    ])
  })

  it('orders longest first so overlapping values cannot leave a fragment', () => {
    const ctx: EvalContext = {
      kind: 'user',
      key: 'u_1',
      short: 'ada',
      long: 'ada@example.com',
      _meta: { privateAttributes: ['short', 'long'] },
    }
    expect(privateAttributeValues(ctx)[0]).toBe('ada@example.com')
  })
})

describe('redactValue', () => {
  const privateValues = ['ada@example.com', '42']

  it('leaves values alone when nothing is private', () => {
    expect(redactValue('ada@example.com', [])).toBe('ada@example.com')
  })

  it('redacts a string value that IS a private value', () => {
    expect(redactValue('ada@example.com', privateValues)).toBe(REDACTED)
  })

  it('redacts a string value that CONTAINS a private value', () => {
    // The old implementation compared against attribute names, so a value that
    // embedded the address sailed through into the log.
    expect(redactValue('welcome ada@example.com', privateValues)).toBe(REDACTED)
  })

  it('redacts a JSON value carrying a private value anywhere inside it', () => {
    expect(
      redactValue({ copy: 'hi', to: 'ada@example.com' }, privateValues)
    ).toBe(REDACTED)
  })

  it('redacts a number value equal to a private number', () => {
    expect(redactValue(42, privateValues)).toBe(REDACTED)
  })

  it('keeps values that share no private text', () => {
    expect(redactValue('blue', privateValues)).toBe('blue')
    expect(redactValue({ theme: 'dark' }, privateValues)).toEqual({ theme: 'dark' })
    expect(redactValue(7, privateValues)).toBe(7)
  })

  it('leaves null and undefined untouched', () => {
    expect(redactValue(null, privateValues)).toBeNull()
    expect(redactValue(undefined, privateValues)).toBeUndefined()
  })

  it('matches a single-character private value only exactly, never as a substring', () => {
    // "a" appears in almost every string; substring-matching it would redact
    // the entire log. Documented behaviour, pinned here.
    expect(redactValue('a', ['a'])).toBe(REDACTED)
    expect(redactValue('blue', ['a'])).toBe('blue')
  })
})

describe('redactReasons', () => {
  it('replaces private values inside reason prose', () => {
    const reasons = [
      'matched audience on email="ada@example.com"',
      'traffic allocation 100%',
    ]
    expect(redactReasons(reasons, ['ada@example.com'])).toEqual([
      `matched audience on email="${REDACTED}"`,
      'traffic allocation 100%',
    ])
  })

  it('replaces every occurrence, not just the first', () => {
    expect(
      redactReasons(['a@b.com then a@b.com again'], ['a@b.com'])
    ).toEqual([`${REDACTED} then ${REDACTED} again`])
  })

  it('redacts a reason that is exactly a private value, whatever its length', () => {
    expect(redactReasons(['x'], ['x'])).toEqual([REDACTED])
  })

  it('leaves reasons alone when nothing is private', () => {
    expect(redactReasons(['matched rule r1'], [])).toEqual(['matched rule r1'])
  })

  it('returns a copy, so the caller cannot mutate the flag reasons through it', () => {
    const reasons = ['matched rule r1']
    const out = redactReasons(reasons, [])
    expect(out).not.toBe(reasons)
  })
})

describe('appendDecisionLogEntry', () => {
  it('writes a redacted entry with the full shape', () => {
    const log = createDecisionLog()
    appendDecisionLogEntry(log, {
      flagKey: 'welcome-copy',
      value: 'hello ada@example.com',
      variationKey: 'personalised',
      source: 'rule',
      ruleId: 'r1',
      ruleType: 'ab_test',
      reasons: ['matched audience on email="ada@example.com"'],
      evaluatedAt: 1_700_000_000_000,
      durationMicros: 12,
      contextSummary: [{ kind: 'user', key: 'u_1' }],
      privateValues: ['ada@example.com'],
    })

    expect(log.entries).toHaveLength(1)
    const entry = log.entries[0]
    expect(entry.value).toBe(REDACTED)
    expect(entry.reasons[0]).toBe(`matched audience on email="${REDACTED}"`)
    expect(entry.flagKey).toBe('welcome-copy')
    expect(entry.variationKey).toBe('personalised')
    expect(entry.durationMicros).toBe(12)
    expect(entry.contextSummary).toEqual([{ kind: 'user', key: 'u_1' }])
    expect(entry.manuallyFired).toBeUndefined()
  })

  it('marks manually fired entries', () => {
    const log = createDecisionLog()
    appendDecisionLogEntry(log, {
      flagKey: 'f',
      value: true,
      variationKey: 'on',
      source: 'rule',
      ruleId: 'r1',
      ruleType: 'ab_test',
      reasons: [],
      evaluatedAt: 1,
      durationMicros: 0,
      contextSummary: [],
      privateValues: [],
      manuallyFired: true,
    })
    expect(log.entries[0].manuallyFired).toBe(true)
  })

  it('keeps values intact when the context declared nothing private', () => {
    const log = createDecisionLog()
    appendDecisionLogEntry(log, {
      flagKey: 'f',
      value: 'ada@example.com',
      variationKey: null,
      source: 'default',
      ruleId: null,
      ruleType: null,
      reasons: ['no rule matched'],
      evaluatedAt: 1,
      durationMicros: 0,
      contextSummary: [],
      privateValues: [],
    })
    expect(log.entries[0].value).toBe('ada@example.com')
  })
})
