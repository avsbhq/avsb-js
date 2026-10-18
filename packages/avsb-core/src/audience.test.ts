import { describe, it, expect } from 'vitest'
import { evaluateAudience, evaluateGroup, evaluateCondition } from './audience'
import type {
  FlagDatafileAudience,
  ConditionGroup,
  Condition,
  EvalContext,
  MultiContext,
  SingleContext,
} from './types'

// --- Test helpers ---

function makeCondition(overrides: Partial<Condition> = {}): Condition {
  return {
    id: 'c-1',
    type: 'CUSTOM_ATTRIBUTE',
    attribute: 'plan',
    operator: 'equals',
    value: 'pro',
    ...overrides,
  }
}

function makeGroup(overrides: Partial<ConditionGroup> = {}): ConditionGroup {
  return {
    id: 'g-1',
    logic: 'AND',
    conditions: [makeCondition()],
    ...overrides,
  }
}

function makeAudience(overrides: Partial<FlagDatafileAudience> = {}): FlagDatafileAudience {
  return {
    id: 'aud-1',
    rules: makeGroup(),
    ...overrides,
  }
}

/**
 * Build a single-context user from the legacy flat attribute bag. The
 * audience evaluator now consumes the new `EvalContext` shape natively
 * (with backward-compat for legacy bags); this helper bridges the
 * existing test expressions into the new shape.
 */
function makeContext(attributes: Record<string, unknown> = {}): EvalContext {
  const key = String(attributes['userId'] ?? '')
  const ctx: SingleContext = { kind: 'user', key }
  for (const [k, v] of Object.entries(attributes)) {
    if (k === 'userId') continue
    ctx[k] = v
  }
  return ctx
}

// --- evaluateCondition: unknown types fail closed ---

describe('evaluateCondition — unknown types fail closed', () => {
  it('returns false for an unknown type like LOCATION', () => {
    const condition = makeCondition({ type: 'LOCATION', attribute: undefined, operator: 'equals', value: 'US' })
    expect(evaluateCondition(condition, makeContext())).toBe(false)
  })

  it('returns false for an unknown type like CUSTOM_JS', () => {
    const condition = makeCondition({ type: 'CUSTOM_JS', attribute: undefined, operator: 'equals', value: 'return true' })
    expect(evaluateCondition(condition, makeContext())).toBe(false)
  })

  it('returns false for a completely made-up type', () => {
    const condition = makeCondition({ type: 'TOTALLY_UNKNOWN', attribute: undefined, operator: 'equals', value: 'anything' })
    expect(evaluateCondition(condition, makeContext())).toBe(false)
  })
})

// --- evaluateCondition: CUSTOM_ATTRIBUTE operators ---

describe('evaluateCondition — CUSTOM_ATTRIBUTE', () => {
  describe('equals / not_equals', () => {
    it('matches with equals operator', () => {
      const condition = makeCondition({ operator: 'equals', value: 'pro' })
      expect(evaluateCondition(condition, makeContext({ plan: 'pro' }))).toBe(true)
    })

    it('does not match a different value with equals', () => {
      const condition = makeCondition({ operator: 'equals', value: 'pro' })
      expect(evaluateCondition(condition, makeContext({ plan: 'free' }))).toBe(false)
    })

    it('matches with not_equals operator when values differ', () => {
      const condition = makeCondition({ operator: 'not_equals', value: 'pro' })
      expect(evaluateCondition(condition, makeContext({ plan: 'free' }))).toBe(true)
    })

    it('does not match with not_equals when values are the same', () => {
      const condition = makeCondition({ operator: 'not_equals', value: 'pro' })
      expect(evaluateCondition(condition, makeContext({ plan: 'pro' }))).toBe(false)
    })

    it('returns false for equals when attribute is missing from context', () => {
      const condition = makeCondition({ operator: 'equals', value: 'pro' })
      expect(evaluateCondition(condition, makeContext({}))).toBe(false)
    })
  })

  describe('exists / not_exists', () => {
    it('returns true with exists when attribute is present', () => {
      const condition = makeCondition({ operator: 'exists', value: '' })
      expect(evaluateCondition(condition, makeContext({ plan: 'free' }))).toBe(true)
    })

    it('returns false with exists when attribute is absent', () => {
      const condition = makeCondition({ operator: 'exists', value: '' })
      expect(evaluateCondition(condition, makeContext({}))).toBe(false)
    })

    it('returns true with exists when attribute is 0 (falsy but defined)', () => {
      const condition = makeCondition({ attribute: 'count', operator: 'exists', value: '' })
      expect(evaluateCondition(condition, makeContext({ count: 0 }))).toBe(true)
    })

    it('returns true with not_exists when attribute is absent', () => {
      const condition = makeCondition({ operator: 'not_exists', value: '' })
      expect(evaluateCondition(condition, makeContext({}))).toBe(true)
    })

    it('returns false with not_exists when attribute is present', () => {
      const condition = makeCondition({ operator: 'not_exists', value: '' })
      expect(evaluateCondition(condition, makeContext({ plan: 'pro' }))).toBe(false)
    })

    it('returns true with not_exists when attribute is null', () => {
      const condition = makeCondition({ operator: 'not_exists', value: '' })
      expect(evaluateCondition(condition, makeContext({ plan: null }))).toBe(true)
    })
  })

  describe('contains / not_contains', () => {
    it('matches with contains operator (case-insensitive)', () => {
      const condition = makeCondition({ attribute: 'email', operator: 'contains', value: 'EXAMPLE' })
      expect(evaluateCondition(condition, makeContext({ email: 'user@example.com' }))).toBe(true)
    })

    it('returns false with contains when substring is absent', () => {
      const condition = makeCondition({ attribute: 'email', operator: 'contains', value: 'other.com' })
      expect(evaluateCondition(condition, makeContext({ email: 'user@example.com' }))).toBe(false)
    })

    it('matches with not_contains when substring is absent', () => {
      const condition = makeCondition({ attribute: 'email', operator: 'not_contains', value: 'spam' })
      expect(evaluateCondition(condition, makeContext({ email: 'user@example.com' }))).toBe(true)
    })

    it('returns false with not_contains when substring is present', () => {
      const condition = makeCondition({ attribute: 'email', operator: 'not_contains', value: 'example' })
      expect(evaluateCondition(condition, makeContext({ email: 'user@example.com' }))).toBe(false)
    })
  })

  describe('starts_with / ends_with', () => {
    it('matches with starts_with', () => {
      const condition = makeCondition({ attribute: 'role', operator: 'starts_with', value: 'admin' })
      expect(evaluateCondition(condition, makeContext({ role: 'admin_user' }))).toBe(true)
    })

    it('returns false with starts_with when prefix does not match', () => {
      const condition = makeCondition({ attribute: 'role', operator: 'starts_with', value: 'super' })
      expect(evaluateCondition(condition, makeContext({ role: 'admin_user' }))).toBe(false)
    })

    it('matches with ends_with', () => {
      const condition = makeCondition({ attribute: 'email', operator: 'ends_with', value: '.com' })
      expect(evaluateCondition(condition, makeContext({ email: 'user@example.com' }))).toBe(true)
    })

    it('returns false with ends_with when suffix does not match', () => {
      const condition = makeCondition({ attribute: 'email', operator: 'ends_with', value: '.org' })
      expect(evaluateCondition(condition, makeContext({ email: 'user@example.com' }))).toBe(false)
    })
  })

  describe('in_list / not_in_list', () => {
    it('matches with in_list when value is in the array', () => {
      const condition = makeCondition({ attribute: 'country', operator: 'in_list', value: ['US', 'GB', 'CA'] })
      expect(evaluateCondition(condition, makeContext({ country: 'GB' }))).toBe(true)
    })

    it('returns false with in_list when value is not in the array', () => {
      const condition = makeCondition({ attribute: 'country', operator: 'in_list', value: ['US', 'GB', 'CA'] })
      expect(evaluateCondition(condition, makeContext({ country: 'AU' }))).toBe(false)
    })

    it('matches with in_list when value is a single string (not array)', () => {
      const condition = makeCondition({ attribute: 'plan', operator: 'in_list', value: 'pro' })
      expect(evaluateCondition(condition, makeContext({ plan: 'pro' }))).toBe(true)
    })

    it('matches with not_in_list when value is absent from the list', () => {
      const condition = makeCondition({ attribute: 'country', operator: 'not_in_list', value: ['US', 'GB'] })
      expect(evaluateCondition(condition, makeContext({ country: 'AU' }))).toBe(true)
    })

    it('returns false with not_in_list when value is in the list', () => {
      const condition = makeCondition({ attribute: 'country', operator: 'not_in_list', value: ['US', 'GB'] })
      expect(evaluateCondition(condition, makeContext({ country: 'US' }))).toBe(false)
    })
  })

  describe('greater_than / less_than / gte / lte', () => {
    it('matches with greater_than when actual exceeds expected', () => {
      const condition = makeCondition({ attribute: 'age', operator: 'greater_than', value: '18' })
      expect(evaluateCondition(condition, makeContext({ age: 25 }))).toBe(true)
    })

    it('returns false with greater_than when actual equals expected', () => {
      const condition = makeCondition({ attribute: 'age', operator: 'greater_than', value: '25' })
      expect(evaluateCondition(condition, makeContext({ age: 25 }))).toBe(false)
    })

    it('matches with less_than when actual is below expected', () => {
      const condition = makeCondition({ attribute: 'age', operator: 'less_than', value: '18' })
      expect(evaluateCondition(condition, makeContext({ age: 15 }))).toBe(true)
    })

    it('returns false with less_than when actual equals expected', () => {
      const condition = makeCondition({ attribute: 'age', operator: 'less_than', value: '15' })
      expect(evaluateCondition(condition, makeContext({ age: 15 }))).toBe(false)
    })

    it('matches with gte when actual equals expected', () => {
      const condition = makeCondition({ attribute: 'score', operator: 'gte', value: '100' })
      expect(evaluateCondition(condition, makeContext({ score: 100 }))).toBe(true)
    })

    it('matches with lte when actual equals expected', () => {
      const condition = makeCondition({ attribute: 'score', operator: 'lte', value: '100' })
      expect(evaluateCondition(condition, makeContext({ score: 100 }))).toBe(true)
    })
  })

  describe('regex', () => {
    it('matches with regex operator', () => {
      const condition = makeCondition({ attribute: 'email', operator: 'regex', value: '^[^@]+@example\\.com$' })
      expect(evaluateCondition(condition, makeContext({ email: 'user@example.com' }))).toBe(true)
    })

    it('returns false with regex when pattern does not match', () => {
      const condition = makeCondition({ attribute: 'email', operator: 'regex', value: '^admin@' })
      expect(evaluateCondition(condition, makeContext({ email: 'user@example.com' }))).toBe(false)
    })

    it('returns false when regex pattern is invalid', () => {
      const condition = makeCondition({ attribute: 'email', operator: 'regex', value: '[invalid(' })
      expect(evaluateCondition(condition, makeContext({ email: 'user@example.com' }))).toBe(false)
    })

    it('is case-insensitive for regex matches', () => {
      const condition = makeCondition({ attribute: 'plan', operator: 'regex', value: '^PRO$' })
      expect(evaluateCondition(condition, makeContext({ plan: 'pro' }))).toBe(true)
    })
  })

  describe('missing attribute', () => {
    it('returns false for equals when the attribute key is absent from context', () => {
      const condition = makeCondition({ attribute: 'missing_key', operator: 'equals', value: 'anything' })
      expect(evaluateCondition(condition, makeContext({}))).toBe(false)
    })

    it('returns false when condition has no attribute key defined', () => {
      const condition = makeCondition({ attribute: undefined, operator: 'equals', value: 'pro' })
      expect(evaluateCondition(condition, makeContext({ plan: 'pro' }))).toBe(false)
    })
  })

  describe('unknown operator', () => {
    it('returns false for an unrecognized operator', () => {
      const condition = makeCondition({ operator: 'no_such_operator', value: '10' })
      expect(evaluateCondition(condition, makeContext({ plan: 'pro' }))).toBe(false)
    })

    it('returns false for between, which is a commerce-only operator', () => {
      const condition = makeCondition({ operator: 'between', value: ['10', '20'] })
      expect(evaluateCondition(condition, makeContext({ plan: '15' }))).toBe(false)
    })
  })

  // Spec §1.4 operator matrix. The dashboard audience builder writes
  // these alias spellings, and they reach CUSTOM_ATTRIBUTE conditions.
  // Until this lock they fell through to the default branch, so an
  // audience saved with `is` matched nobody and said nothing.
  describe('alias operators', () => {
    it('treats is as equals', () => {
      const hit = makeCondition({ operator: 'is', value: 'pro' })
      expect(evaluateCondition(hit, makeContext({ plan: 'pro' }))).toBe(true)
      expect(evaluateCondition(hit, makeContext({ plan: 'free' }))).toBe(false)
    })

    it('treats is_not as not_equals', () => {
      const condition = makeCondition({ operator: 'is_not', value: 'pro' })
      expect(evaluateCondition(condition, makeContext({ plan: 'free' }))).toBe(true)
      expect(evaluateCondition(condition, makeContext({ plan: 'pro' }))).toBe(false)
    })

    it('treats does_not_contain as not_contains, case-insensitively', () => {
      const condition = makeCondition({
        attribute: 'email',
        operator: 'does_not_contain',
        value: '@acme.com',
      })
      expect(
        evaluateCondition(condition, makeContext({ email: 'a@other.com' }))
      ).toBe(true)
      expect(
        evaluateCondition(condition, makeContext({ email: 'a@ACME.com' }))
      ).toBe(false)
    })

    it('treats does_not_exist as not_exists', () => {
      const condition = makeCondition({
        attribute: 'plan',
        operator: 'does_not_exist',
        value: '',
      })
      expect(evaluateCondition(condition, makeContext({}))).toBe(true)
      expect(evaluateCondition(condition, makeContext({ plan: 'free' }))).toBe(
        false
      )
    })

    it('keeps the canonical spellings working alongside the aliases', () => {
      const canonical = makeCondition({ operator: 'equals', value: 'pro' })
      const alias = makeCondition({ operator: 'is', value: 'pro' })
      const ctx = makeContext({ plan: 'pro' })
      expect(evaluateCondition(canonical, ctx)).toBe(
        evaluateCondition(alias, ctx)
      )
    })
  })
})

// --- evaluateGroup: AND / OR logic ---

describe('evaluateGroup — AND/OR logic', () => {
  it('returns true for empty conditions array', () => {
    const group = makeGroup({ conditions: [] })
    expect(evaluateGroup(group, makeContext())).toBe(true)
  })

  it('returns true for null group', () => {
    expect(evaluateGroup(null as unknown as ConditionGroup, makeContext())).toBe(true)
  })

  describe('AND group', () => {
    it('returns true when all conditions pass', () => {
      const group = makeGroup({
        logic: 'AND',
        conditions: [
          makeCondition({ id: 'c-1', attribute: 'plan', operator: 'equals', value: 'pro' }),
          makeCondition({ id: 'c-2', attribute: 'country', operator: 'equals', value: 'US' }),
        ],
      })
      expect(evaluateGroup(group, makeContext({ plan: 'pro', country: 'US' }))).toBe(true)
    })

    it('returns false when one condition fails', () => {
      const group = makeGroup({
        logic: 'AND',
        conditions: [
          makeCondition({ id: 'c-1', attribute: 'plan', operator: 'equals', value: 'pro' }),
          makeCondition({ id: 'c-2', attribute: 'country', operator: 'equals', value: 'GB' }),
        ],
      })
      expect(evaluateGroup(group, makeContext({ plan: 'pro', country: 'US' }))).toBe(false)
    })

    it('returns false when all conditions fail', () => {
      const group = makeGroup({
        logic: 'AND',
        conditions: [
          makeCondition({ id: 'c-1', attribute: 'plan', operator: 'equals', value: 'enterprise' }),
          makeCondition({ id: 'c-2', attribute: 'country', operator: 'equals', value: 'GB' }),
        ],
      })
      expect(evaluateGroup(group, makeContext({ plan: 'pro', country: 'US' }))).toBe(false)
    })
  })

  describe('OR group', () => {
    it('returns true when at least one condition passes', () => {
      const group = makeGroup({
        logic: 'OR',
        conditions: [
          makeCondition({ id: 'c-1', attribute: 'plan', operator: 'equals', value: 'free' }),
          makeCondition({ id: 'c-2', attribute: 'plan', operator: 'equals', value: 'pro' }),
        ],
      })
      expect(evaluateGroup(group, makeContext({ plan: 'pro' }))).toBe(true)
    })

    it('returns false when all conditions fail', () => {
      const group = makeGroup({
        logic: 'OR',
        conditions: [
          makeCondition({ id: 'c-1', attribute: 'plan', operator: 'equals', value: 'free' }),
          makeCondition({ id: 'c-2', attribute: 'plan', operator: 'equals', value: 'enterprise' }),
        ],
      })
      expect(evaluateGroup(group, makeContext({ plan: 'pro' }))).toBe(false)
    })
  })
})

// --- evaluateGroup: unknown types inside groups ---

describe('evaluateGroup — unknown types inside groups', () => {
  it('unknown type in AND group causes the entire group to fail', () => {
    const group = makeGroup({
      logic: 'AND',
      conditions: [
        makeCondition({ id: 'c-1', attribute: 'plan', operator: 'equals', value: 'pro' }),
        makeCondition({ id: 'c-2', type: 'LOCATION', attribute: undefined, operator: 'equals', value: 'US' }),
      ],
    })
    // LOCATION is unknown → returns false → AND short-circuits to false
    expect(evaluateGroup(group, makeContext({ plan: 'pro' }))).toBe(false)
  })

  it('unknown type in OR group does not block a passing known condition', () => {
    const group = makeGroup({
      logic: 'OR',
      conditions: [
        makeCondition({ id: 'c-1', type: 'CUSTOM_JS', attribute: undefined, operator: 'equals', value: 'return true' }),
        makeCondition({ id: 'c-2', attribute: 'plan', operator: 'equals', value: 'pro' }),
      ],
    })
    // CUSTOM_JS returns false, but CUSTOM_ATTRIBUTE equals passes → OR returns true
    expect(evaluateGroup(group, makeContext({ plan: 'pro' }))).toBe(true)
  })

  it('all unknown types in OR group returns false', () => {
    const group = makeGroup({
      logic: 'OR',
      conditions: [
        makeCondition({ id: 'c-1', type: 'LOCATION', attribute: undefined, operator: 'equals', value: 'US' }),
        makeCondition({ id: 'c-2', type: 'CUSTOM_JS', attribute: undefined, operator: 'equals', value: 'return true' }),
      ],
    })
    expect(evaluateGroup(group, makeContext({}))).toBe(false)
  })
})

// --- evaluateAudience ---

describe('evaluateAudience', () => {
  it('returns true when audience is null', () => {
    expect(evaluateAudience(null as unknown as FlagDatafileAudience, makeContext())).toBe(true)
  })

  it('returns true when audience is undefined', () => {
    expect(evaluateAudience(undefined as unknown as FlagDatafileAudience, makeContext())).toBe(true)
  })

  it('returns true when audience has no rules', () => {
    const audience = { id: 'aud-1', rules: null as unknown as ConditionGroup }
    expect(evaluateAudience(audience, makeContext())).toBe(true)
  })

  it('returns true when audience rules have empty conditions', () => {
    const audience = makeAudience({ rules: makeGroup({ conditions: [] }) })
    expect(evaluateAudience(audience, makeContext())).toBe(true)
  })

  it('returns true when audience conditions all match', () => {
    const audience = makeAudience({
      rules: makeGroup({
        logic: 'AND',
        conditions: [
          makeCondition({ id: 'c-1', attribute: 'plan', operator: 'equals', value: 'pro' }),
        ],
      }),
    })
    expect(evaluateAudience(audience, makeContext({ plan: 'pro' }))).toBe(true)
  })

  it('returns false when audience conditions do not match', () => {
    const audience = makeAudience({
      rules: makeGroup({
        logic: 'AND',
        conditions: [
          makeCondition({ id: 'c-1', attribute: 'plan', operator: 'equals', value: 'enterprise' }),
        ],
      }),
    })
    expect(evaluateAudience(audience, makeContext({ plan: 'pro' }))).toBe(false)
  })

  it('returns false when audience contains an unknown condition type', () => {
    const audience = makeAudience({
      rules: makeGroup({
        logic: 'AND',
        conditions: [
          makeCondition({ id: 'c-1', type: 'LOCATION', attribute: undefined, operator: 'equals', value: 'US' }),
        ],
      }),
    })
    expect(evaluateAudience(audience, makeContext({}))).toBe(false)
  })
})

// --- Nested groups ---

describe('nested groups', () => {
  it('nested AND inside OR: passes when nested AND group satisfies', () => {
    // OR( CUSTOM_ATTRIBUTE(plan=free), AND(plan=pro, country=US) )
    const innerAnd: ConditionGroup = {
      id: 'inner-and',
      logic: 'AND',
      conditions: [
        makeCondition({ id: 'c-inner-1', attribute: 'plan', operator: 'equals', value: 'pro' }),
        makeCondition({ id: 'c-inner-2', attribute: 'country', operator: 'equals', value: 'US' }),
      ],
    }
    const outerOr: ConditionGroup = {
      id: 'outer-or',
      logic: 'OR',
      conditions: [
        makeCondition({ id: 'c-outer-1', attribute: 'plan', operator: 'equals', value: 'free' }),
        innerAnd,
      ],
    }
    // plan=pro, country=US → outer free fails, inner AND (pro+US) passes → OR passes
    expect(evaluateGroup(outerOr, makeContext({ plan: 'pro', country: 'US' }))).toBe(true)
  })

  it('nested AND inside OR: fails when neither branch satisfies', () => {
    const innerAnd: ConditionGroup = {
      id: 'inner-and',
      logic: 'AND',
      conditions: [
        makeCondition({ id: 'c-inner-1', attribute: 'plan', operator: 'equals', value: 'enterprise' }),
        makeCondition({ id: 'c-inner-2', attribute: 'country', operator: 'equals', value: 'US' }),
      ],
    }
    const outerOr: ConditionGroup = {
      id: 'outer-or',
      logic: 'OR',
      conditions: [
        makeCondition({ id: 'c-outer-1', attribute: 'plan', operator: 'equals', value: 'free' }),
        innerAnd,
      ],
    }
    // plan=pro: free fails, enterprise+US fails → OR fails
    expect(evaluateGroup(outerOr, makeContext({ plan: 'pro', country: 'US' }))).toBe(false)
  })

  it('nested OR inside AND: passes when all top-level conditions satisfy', () => {
    // AND( plan=pro, OR(country=US, country=GB) )
    const innerOr: ConditionGroup = {
      id: 'inner-or',
      logic: 'OR',
      conditions: [
        makeCondition({ id: 'c-inner-1', attribute: 'country', operator: 'equals', value: 'US' }),
        makeCondition({ id: 'c-inner-2', attribute: 'country', operator: 'equals', value: 'GB' }),
      ],
    }
    const outerAnd: ConditionGroup = {
      id: 'outer-and',
      logic: 'AND',
      conditions: [
        makeCondition({ id: 'c-outer-1', attribute: 'plan', operator: 'equals', value: 'pro' }),
        innerOr,
      ],
    }
    // plan=pro ✓, country=GB matches inner OR ✓ → AND passes
    expect(evaluateGroup(outerAnd, makeContext({ plan: 'pro', country: 'GB' }))).toBe(true)
  })

  it('nested OR inside AND: fails when outer AND condition fails', () => {
    const innerOr: ConditionGroup = {
      id: 'inner-or',
      logic: 'OR',
      conditions: [
        makeCondition({ id: 'c-inner-1', attribute: 'country', operator: 'equals', value: 'US' }),
        makeCondition({ id: 'c-inner-2', attribute: 'country', operator: 'equals', value: 'GB' }),
      ],
    }
    const outerAnd: ConditionGroup = {
      id: 'outer-and',
      logic: 'AND',
      conditions: [
        makeCondition({ id: 'c-outer-1', attribute: 'plan', operator: 'equals', value: 'enterprise' }),
        innerOr,
      ],
    }
    // plan=pro fails enterprise check → AND short-circuits to false
    expect(evaluateGroup(outerAnd, makeContext({ plan: 'pro', country: 'US' }))).toBe(false)
  })

  it('deeply nested groups evaluate correctly', () => {
    // AND( OR( AND(plan=pro, role=admin), plan=enterprise ), country=US )
    const deepestAnd: ConditionGroup = {
      id: 'deepest-and',
      logic: 'AND',
      conditions: [
        makeCondition({ id: 'c-d-1', attribute: 'plan', operator: 'equals', value: 'pro' }),
        makeCondition({ id: 'c-d-2', attribute: 'role', operator: 'equals', value: 'admin' }),
      ],
    }
    const middleOr: ConditionGroup = {
      id: 'middle-or',
      logic: 'OR',
      conditions: [
        deepestAnd,
        makeCondition({ id: 'c-m-1', attribute: 'plan', operator: 'equals', value: 'enterprise' }),
      ],
    }
    const outerAnd: ConditionGroup = {
      id: 'outer-and',
      logic: 'AND',
      conditions: [
        middleOr,
        makeCondition({ id: 'c-o-1', attribute: 'country', operator: 'equals', value: 'US' }),
      ],
    }
    // plan=pro, role=admin → deepest AND passes → middle OR passes → country=US ✓ → outer AND passes
    expect(
      evaluateGroup(outerAnd, makeContext({ plan: 'pro', role: 'admin', country: 'US' }))
    ).toBe(true)

    // plan=pro, role=viewer → deepest AND fails → enterprise check fails → middle OR fails → outer AND fails
    expect(
      evaluateGroup(outerAnd, makeContext({ plan: 'pro', role: 'viewer', country: 'US' }))
    ).toBe(false)
  })
})

// --- Multi-context conditions (§8.1) ---

describe('evaluateCondition — contextKind on CUSTOM_ATTRIBUTE', () => {
  it('matches when the condition names a sub-context that carries the attribute', () => {
    const ctx: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-1' },
      organization: { kind: 'organization', key: 'org-1', tier: 'enterprise' },
    }
    const condition: Condition = {
      id: 'c-1',
      type: 'CUSTOM_ATTRIBUTE',
      contextKind: 'organization',
      attribute: 'tier',
      operator: 'equals',
      value: 'enterprise',
    }
    expect(evaluateCondition(condition, ctx)).toBe(true)
  })

  it('fails closed when the named sub-context is absent from the eval context', () => {
    const ctx: SingleContext = { kind: 'user', key: 'u-1', tier: 'enterprise' }
    // tier='enterprise' is on the user, but the condition targets
    // organization — should not match (no synthesized cross-kind lookup).
    const condition: Condition = {
      id: 'c-1',
      type: 'CUSTOM_ATTRIBUTE',
      contextKind: 'organization',
      attribute: 'tier',
      operator: 'equals',
      value: 'enterprise',
    }
    expect(evaluateCondition(condition, ctx)).toBe(false)
  })

  it('resolves attribute="key" to the sub-context key (not an attribute bag lookup)', () => {
    const ctx: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-1' },
      organization: { kind: 'organization', key: 'org-42' },
    }
    const condition: Condition = {
      id: 'c-1',
      type: 'CUSTOM_ATTRIBUTE',
      contextKind: 'organization',
      attribute: 'key',
      operator: 'equals',
      value: 'org-42',
    }
    expect(evaluateCondition(condition, ctx)).toBe(true)
  })

  it('legacy condition without contextKind reads the primary context (user)', () => {
    const ctx: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-1', plan: 'pro' },
      organization: { kind: 'organization', key: 'org-1' },
    }
    const condition: Condition = {
      id: 'c-1',
      type: 'CUSTOM_ATTRIBUTE',
      attribute: 'plan',
      operator: 'equals',
      value: 'pro',
    }
    expect(evaluateCondition(condition, ctx)).toBe(true)
  })

  it('returns not_exists=true when the contextKind is missing entirely', () => {
    const ctx: SingleContext = { kind: 'user', key: 'u-1' }
    const condition: Condition = {
      id: 'c-1',
      type: 'CUSTOM_ATTRIBUTE',
      contextKind: 'organization',
      attribute: 'tier',
      operator: 'not_exists',
      value: '',
    }
    // contextKind missing → condition cannot evaluate against that kind →
    // evaluator returns false (fail closed). not_exists semantics for the
    // attribute do NOT promote a missing context to a match.
    expect(evaluateCondition(condition, ctx)).toBe(false)
  })
})

// --- Version operators (semver_*), through the real condition dispatch ---

describe('evaluateCondition: version operators on CUSTOM_ATTRIBUTE', () => {
  function versionCondition(operator: string, value: string | string[]): Condition {
    return makeCondition({ attribute: 'appVersion', operator, value })
  }

  it('compares as versions, not text: 2.10.0 is greater than 2.9.1', () => {
    const condition = versionCondition('semver_gt', '2.9.1')
    expect(evaluateCondition(condition, makeContext({ appVersion: '2.10.0' }))).toBe(true)
    expect(evaluateCondition(condition, makeContext({ appVersion: '2.9.0' }))).toBe(false)
  })

  it('reads the first entry of an array rule value, like every other operator', () => {
    const condition = versionCondition('semver_gte', ['2.3.0', '9.9.9'])
    expect(evaluateCondition(condition, makeContext({ appVersion: 'v2.3' }))).toBe(true)
  })

  it('answers false when the attribute is missing, semver_neq included', () => {
    expect(evaluateCondition(versionCondition('semver_neq', '1.0.0'), makeContext({}))).toBe(false)
    expect(evaluateCondition(versionCondition('semver_lt', '1.0.0'), makeContext({}))).toBe(false)
  })

  it('answers false for an unparsable side instead of throwing', () => {
    expect(
      evaluateCondition(versionCondition('semver_gte', '2.x'), makeContext({ appVersion: '3.0.0' }))
    ).toBe(false)
    expect(
      evaluateCondition(versionCondition('semver_neq', '2.0.0'), makeContext({ appVersion: 'banana' }))
    ).toBe(false)
  })

  it('resolves the attribute through a declared contextKind', () => {
    const ctx: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-1' },
      device: { kind: 'device', key: 'd-1', appVersion: '3.1.0' },
    }
    const condition: Condition = {
      ...versionCondition('semver_gte', '3.0.0'),
      contextKind: 'device',
    }
    expect(evaluateCondition(condition, ctx)).toBe(true)
    expect(evaluateCondition({ ...condition, contextKind: 'organization' }, ctx)).toBe(false)
  })
})
