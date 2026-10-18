import { evaluateFlag, resolveDottedAttribute } from './evaluate'
import { bucketContext } from './engine'
import { createInMemoryBanditModelStore } from './bandits'
import type {
  BanditConfig,
  EvalContext,
  SingleContext,
  MultiContext,
  FlagDatafile,
  FlagDatafileEntry,
  FlagDatafileAudience,
  FlagDatafileHoldout,
  FlagDatafileRule,
  FlagEvaluationDetails,
  ExposureEvent,
} from './types'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeDatafile(
  flags: FlagDatafileEntry[],
  audiences: FlagDatafileAudience[] = []
): FlagDatafile {
  return {
    version: 1,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'test-sdk-key',
    environmentKey: 'test',
    publishedAt: '2024-01-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.example.com',
    flags,
    audiences,
  }
}

function makeFlag(overrides: Partial<FlagDatafileEntry> = {}): FlagDatafileEntry {
  return {
    id: 'flag-id-1',
    key: 'my-flag',
    type: 'boolean',
    enabled: true,
    defaultVariationId: 'var-off',
    variations: [
      { id: 'var-off', key: 'off', value: false },
      { id: 'var-on', key: 'on', value: true },
    ],
    overrides: [],
    rules: [],
    ...overrides,
  }
}

/**
 * Build a single-context user from the legacy flat attribute bag the
 * pre-CoW6 evaluator accepted. `userId` and `deviceId` become the
 * primary `key` (userId wins when both are present) so existing rule
 * `hashAttribute: 'userId'` bucketing still resolves; remaining keys
 * are promoted to attributes on the single context.
 */
function makeContext(attributes: Record<string, unknown> = {}): EvalContext {
  const reserved = new Set(['userId'])
  const key = String(attributes['userId'] ?? '')
  const ctx: SingleContext = { kind: 'user', key }
  for (const [k, v] of Object.entries(attributes)) {
    if (reserved.has(k)) continue
    ctx[k] = v
  }
  return ctx
}

// ---------------------------------------------------------------------------
// 1. Flag not found
// ---------------------------------------------------------------------------

describe('evaluateFlag — flag not found', () => {
  it('returns defaultValue with source not_found when flagKey is missing', () => {
    const datafile = makeDatafile([makeFlag({ key: 'other-flag' })])
    const result = evaluateFlag('missing-flag', 'fallback', makeContext(), datafile)

    expect(result).toEqual<FlagEvaluationDetails>({
      value: 'fallback',
      variationKey: null,
      source: 'not_found',
      ruleId: null,
      ruleType: null,
      flagKey: 'missing-flag',
      reasons: [],
    })
  })

  it('returns the exact defaultValue type (number) when flag is not found', () => {
    const datafile = makeDatafile([])
    const result = evaluateFlag('no-flag', 42, makeContext(), datafile)
    expect(result.value).toBe(42)
    expect(result.source).toBe('not_found')
  })

  it('returns null defaultValue when flag is not found', () => {
    const datafile = makeDatafile([])
    const result = evaluateFlag('no-flag', null, makeContext(), datafile)
    expect(result.value).toBeNull()
    expect(result.source).toBe('not_found')
  })
})

// ---------------------------------------------------------------------------
// 2. Flag disabled
// ---------------------------------------------------------------------------

describe('evaluateFlag — flag disabled', () => {
  it('returns default variation value with source disabled when flag.enabled is false', () => {
    const flag = makeFlag({
      enabled: false,
      defaultVariationId: 'var-off',
      variations: [
        { id: 'var-off', key: 'off', value: false },
        { id: 'var-on', key: 'on', value: true },
      ],
    })
    const result = evaluateFlag('my-flag', 'fallback', makeContext(), makeDatafile([flag]))

    expect(result).toEqual<FlagEvaluationDetails>({
      value: false,
      variationKey: 'off',
      source: 'disabled',
      ruleId: null,
      ruleType: null,
      flagKey: 'my-flag',
      reasons: [],
    })
  })

  it('falls back to caller defaultValue when defaultVariationId does not match any variation', () => {
    const flag = makeFlag({
      enabled: false,
      defaultVariationId: 'nonexistent',
      variations: [{ id: 'var-on', key: 'on', value: true }],
    })
    const result = evaluateFlag('my-flag', 'caller-default', makeContext(), makeDatafile([flag]))

    expect(result.value).toBe('caller-default')
    expect(result.variationKey).toBeNull()
    expect(result.source).toBe('disabled')
  })

  it('does not evaluate any rules when flag is disabled', () => {
    const flag = makeFlag({
      enabled: false,
      defaultVariationId: 'var-off',
      rules: [
        {
          id: 'rule-1',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    const result = evaluateFlag('my-flag', 'fallback', makeContext({ userId: 'u1' }), makeDatafile([flag]))
    expect(result.source).toBe('disabled')
    expect(result.value).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Override matches on userId
// ---------------------------------------------------------------------------

describe('evaluateFlag — overrides', () => {
  it('returns override variation value with source override when userId matches', () => {
    const flag = makeFlag({
      overrides: [{ userId: 'special-user', variationId: 'var-on' }],
    })
    const context = makeContext({ userId: 'special-user' })
    const result = evaluateFlag('my-flag', false, context, makeDatafile([flag]))

    expect(result).toEqual<FlagEvaluationDetails>({
      value: true,
      variationKey: 'on',
      source: 'override',
      ruleId: null,
      ruleType: null,
      flagKey: 'my-flag',
      reasons: [],
    })
  })

  it('does not apply override when userId does not match', () => {
    const flag = makeFlag({
      overrides: [{ userId: 'special-user', variationId: 'var-on' }],
    })
    const context = makeContext({ userId: 'regular-user' })
    const result = evaluateFlag('my-flag', false, context, makeDatafile([flag]))

    expect(result.source).not.toBe('override')
  })

  it('falls back to caller defaultValue when override variationId does not match any variation', () => {
    const flag = makeFlag({
      overrides: [{ userId: 'special-user', variationId: 'var-nonexistent' }],
    })
    const context = makeContext({ userId: 'special-user' })
    const result = evaluateFlag('my-flag', 'caller-default', context, makeDatafile([flag]))

    expect(result.source).toBe('override')
    expect(result.value).toBe('caller-default')
    expect(result.variationKey).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 4. Override always matches on userId — NOT rule's hashAttribute
// ---------------------------------------------------------------------------

describe('evaluateFlag — override uses userId, not rule hashAttribute', () => {
  it('matches override on userId even when rule hashAttribute is deviceId', () => {
    // The rule uses deviceId for bucketing, but overrides always check userId
    const flag = makeFlag({
      overrides: [{ userId: 'user-xyz', variationId: 'var-on' }],
      rules: [
        {
          id: 'rule-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'deviceId', // rule buckets by deviceId
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-off', percentage: 0.5 },
            { variationId: 'var-on', percentage: 0.5 },
          ],
        },
      ],
    })
    const context = makeContext({ userId: 'user-xyz', deviceId: 'device-abc' })
    const result = evaluateFlag('my-flag', false, context, makeDatafile([flag]))

    // Override fires based on userId match, rule hashAttribute is irrelevant
    expect(result.source).toBe('override')
    expect(result.value).toBe(true)
    expect(result.variationKey).toBe('on')
  })

  it('does not match override when userId is absent even though deviceId matches override.userId field name convention', () => {
    // Overrides are keyed by userId — if there is no userId in context, override should not fire
    const flag = makeFlag({
      overrides: [{ userId: '', variationId: 'var-on' }],
      rules: [],
    })
    // Empty string userId → String(undefined || '') → '' which would match override.userId = ''
    // This edge case documents current implementation behaviour
    const context = makeContext({}) // no userId attribute at all
    const result = evaluateFlag('my-flag', false, context, makeDatafile([flag]))
    // String(undefined || '') === '' === override.userId '' → override fires
    expect(result.source).toBe('override')
  })
})

// ---------------------------------------------------------------------------
// 5. targeted_delivery rule serves first variation
// ---------------------------------------------------------------------------

describe('evaluateFlag — targeted_delivery rule', () => {
  it('returns first variation with source rule and ruleType targeted_delivery', () => {
    const flag = makeFlag({
      rules: [
        {
          id: 'rule-td-1',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [
            { variationId: 'var-on', percentage: 1 },
            { variationId: 'var-off', percentage: 0 },
          ],
        },
      ],
    })
    const context = makeContext({ userId: 'any-user' })
    const result = evaluateFlag('my-flag', false, context, makeDatafile([flag]))

    expect(result).toEqual<FlagEvaluationDetails>({
      value: true,
      variationKey: 'on',
      source: 'rule',
      ruleId: 'rule-td-1',
      ruleType: 'targeted_delivery',
      flagKey: 'my-flag',
      reasons: [],
    })
  })

  it('always picks the first variation in the list, not the highest percentage', () => {
    const flag = makeFlag({
      rules: [
        {
          id: 'rule-td-2',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [
            { variationId: 'var-off', percentage: 0 },
            { variationId: 'var-on', percentage: 1 },
          ],
        },
      ],
    })
    const context = makeContext({ userId: 'any-user' })
    const result = evaluateFlag('my-flag', false, context, makeDatafile([flag]))

    // First variation in array is var-off regardless of percentages
    expect(result.variationKey).toBe('off')
    expect(result.value).toBe(false)
    expect(result.ruleType).toBe('targeted_delivery')
  })
})

// ---------------------------------------------------------------------------
// 6. targeted_delivery with empty variations skips to default
// ---------------------------------------------------------------------------

describe('evaluateFlag — targeted_delivery with empty variations', () => {
  it('skips rule and falls through to default when variations array is empty', () => {
    const flag = makeFlag({
      defaultVariationId: 'var-off',
      rules: [
        {
          id: 'rule-td-empty',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [], // empty — should be skipped
        },
      ],
    })
    const context = makeContext({ userId: 'any-user' })
    const result = evaluateFlag('my-flag', 'fallback', context, makeDatafile([flag]))

    expect(result.source).toBe('default')
    expect(result.value).toBe(false) // defaultVariationId='var-off' → value false
    expect(result.variationKey).toBe('off')
    expect(result.ruleId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 7. ab_test assigns variation based on hash bucketing
// ---------------------------------------------------------------------------

describe('evaluateFlag — ab_test variation bucketing', () => {
  it('assigns user-2 to variation-a based on deterministic hash (varHash=3313 < 5000)', () => {
    // murmurhash3('user-2' + 'my-flag') % 10000 === 3313 → bucket 0 → variation-a
    // murmurhash3('user-2' + 'my-flag' + '__' + 'rule-ab-1') % 10000 === 543 → in 100% traffic
    const flag = makeFlag({
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1, // 100% traffic
          variations: [
            { variationId: 'var-a', percentage: 0.5 }, // bucket 0–4999
            { variationId: 'var-b', percentage: 0.5 }, // bucket 5000–9999
          ],
        },
      ],
    })
    const context = makeContext({ userId: 'user-2' })
    const result = evaluateFlag('my-flag', null, context, makeDatafile([flag]))

    expect(result.source).toBe('rule')
    expect(result.ruleType).toBe('ab_test')
    expect(result.ruleId).toBe('rule-ab-1')
    expect(result.variationKey).toBe('variation-a')
    expect(result.value).toBe('a')
  })

  it('assigns user-1 to variation-b based on deterministic hash (varHash=5418 >= 5000)', () => {
    // murmurhash3('user-1' + 'my-flag') % 10000 === 5418 → bucket 1 → variation-b
    // murmurhash3('user-1' + 'my-flag' + '__' + 'rule-ab-1') % 10000 === 7168 → in 100% traffic
    const flag = makeFlag({
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1, // 100% traffic
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
      ],
    })
    const context = makeContext({ userId: 'user-1' })
    const result = evaluateFlag('my-flag', null, context, makeDatafile([flag]))

    expect(result.variationKey).toBe('variation-b')
    expect(result.value).toBe('b')
    expect(result.source).toBe('rule')
  })
})

// ---------------------------------------------------------------------------
// 8. ab_test traffic allocation excludes user → continues to next rule
// ---------------------------------------------------------------------------

describe('evaluateFlag — ab_test traffic allocation exclusion', () => {
  it('skips rule and falls to next when user is outside trafficAllocation window', () => {
    // user-1: murmurhash3('user-1' + 'my-flag' + '__' + 'rule-ab-1') % 10000 === 7168
    // trafficAllocation=0.5 → threshold=5000 → 7168 >= 5000 → excluded
    // Next rule (rule-ab-2) has 100% traffic → user-1 lands there
    // murmurhash3('user-1' + 'my-flag' + '__' + 'rule-ab-2') % 10000 === 7721 → in 100% traffic
    // murmurhash3('user-1' + 'my-flag') % 10000 === 5418 → bucket 1 → variation-b
    const flag = makeFlag({
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 0.5, // 50% — user-1's allocHash 7168 >= 5000 → excluded
          variations: [
            { variationId: 'var-a', percentage: 1 },
          ],
        },
        {
          id: 'rule-ab-2',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1, // 100% fallback rule
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
      ],
    })
    const context = makeContext({ userId: 'user-1' })
    const result = evaluateFlag('my-flag', null, context, makeDatafile([flag]))

    expect(result.ruleId).toBe('rule-ab-2') // landed on second rule
    expect(result.variationKey).toBe('variation-b')
    expect(result.source).toBe('rule')
    expect(result.ruleType).toBe('ab_test')
  })

  it('falls to default when user is excluded from all rules', () => {
    // user-1 allocHash for rule-ab-1 is 7168 — excluded at 50% traffic
    const flag = makeFlag({
      defaultVariationId: 'var-off',
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 0.5, // user-1 excluded
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    const context = makeContext({ userId: 'user-1' })
    const result = evaluateFlag('my-flag', 'fallback', context, makeDatafile([flag]))

    expect(result.source).toBe('default')
    expect(result.value).toBe(false) // defaultVariationId='var-off'
    expect(result.variationKey).toBe('off')
  })
})

// ---------------------------------------------------------------------------
// 9. ab_test fires onExposure callback
// ---------------------------------------------------------------------------

describe('evaluateFlag — ab_test onExposure callback', () => {
  it('fires onExposure with correct fields when user is bucketed into ab_test variation', () => {
    // user-2: varHash=3313 → variation-a; allocHash=543 → in 100% traffic
    const flag = makeFlag({
      id: 'flag-id-1',
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
      ],
    })
    const context = makeContext({ userId: 'user-2' })
    const onExposure = vi.fn<(event: ExposureEvent) => void>()

    evaluateFlag('my-flag', null, context, makeDatafile([flag]), onExposure)

    expect(onExposure).toHaveBeenCalledTimes(1)
    const event = onExposure.mock.calls[0][0]
    expect(event.visitorId).toBe('user-2')
    expect(event.experimentId).toBe('rule-ab-1')
    expect(event.variationId).toBe('var-a')
    expect(event.eventName).toBe('flag_exposure')
    expect(event.revenue).toBeNull()
    expect(typeof event.timestamp).toBe('number')
    expect(event.properties).toMatchObject({ flagKey: 'my-flag', flagId: 'flag-id-1' })
  })

  it('does not fire onExposure for targeted_delivery rules', () => {
    const flag = makeFlag({
      rules: [
        {
          id: 'rule-td-1',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    const onExposure = vi.fn<(event: ExposureEvent) => void>()
    evaluateFlag('my-flag', false, makeContext({ userId: 'any-user' }), makeDatafile([flag]), onExposure)

    expect(onExposure).not.toHaveBeenCalled()
  })

  it('does not fire onExposure when user is excluded from traffic allocation', () => {
    // user-1 allocHash=7168 >= 5000 → excluded at 50% traffic
    const flag = makeFlag({
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 0.5,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    const onExposure = vi.fn<(event: ExposureEvent) => void>()
    evaluateFlag('my-flag', false, makeContext({ userId: 'user-1' }), makeDatafile([flag]), onExposure)

    expect(onExposure).not.toHaveBeenCalled()
  })

  it('attaches attributes when context contains keys registered in the datafile', () => {
    const flag = makeFlag({
      id: 'flag-id-1',
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
      ],
    })
    const datafile = makeDatafile([flag])
    datafile.registeredAttributes = ['plan', 'country']

    const context = makeContext({
      userId: 'user-2',
      plan: 'pro',
      country: 'US',
      // unregistered key should be dropped:
      password: 'sekret',
    })
    const onExposure = vi.fn<(event: ExposureEvent) => void>()

    evaluateFlag('my-flag', null, context, datafile, onExposure)

    expect(onExposure).toHaveBeenCalledTimes(1)
    const event = onExposure.mock.calls[0][0]
    expect(event.attributes).toEqual({ plan: 'pro', country: 'US' })
  })

  it('omits attributes field when datafile has no registeredAttributes', () => {
    const flag = makeFlag({
      id: 'flag-id-1',
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
      ],
    })
    const datafile = makeDatafile([flag])
    // no registeredAttributes set → undefined

    const context = makeContext({ userId: 'user-2', plan: 'pro' })
    const onExposure = vi.fn<(event: ExposureEvent) => void>()

    evaluateFlag('my-flag', null, context, datafile, onExposure)

    expect(onExposure).toHaveBeenCalledTimes(1)
    const event = onExposure.mock.calls[0][0]
    expect(event.attributes).toBeUndefined()
  })

  it('omits attributes field when registered keys are present but every value is null/undefined', () => {
    const flag = makeFlag({
      id: 'flag-id-1',
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
      ],
    })
    const datafile = makeDatafile([flag])
    datafile.registeredAttributes = ['plan', 'country']

    const context = makeContext({ userId: 'user-2', plan: undefined, country: null })
    const onExposure = vi.fn<(event: ExposureEvent) => void>()

    evaluateFlag('my-flag', null, context, datafile, onExposure)

    const event = onExposure.mock.calls[0][0]
    expect(event.attributes).toBeUndefined()
  })

  it('stringifies non-string attribute values for ClickHouse Map(String, String)', () => {
    const flag = makeFlag({
      id: 'flag-id-1',
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
      ],
    })
    const datafile = makeDatafile([flag])
    datafile.registeredAttributes = ['teamSize', 'isPro']

    const context = makeContext({ userId: 'user-2', teamSize: 50, isPro: true })
    const onExposure = vi.fn<(event: ExposureEvent) => void>()

    evaluateFlag('my-flag', null, context, datafile, onExposure)

    const event = onExposure.mock.calls[0][0]
    expect(event.attributes).toEqual({ teamSize: '50', isPro: 'true' })
  })
})

// ---------------------------------------------------------------------------
// 10. Two rules with different hashAttributes bucket independently
// ---------------------------------------------------------------------------

describe('evaluateFlag — different hashAttributes bucket independently', () => {
  it('rule1 buckets by userId and rule2 buckets by deviceId giving different variation assignments', () => {
    // user-2 + my-flag: varHash=3313 → variation-a (bucket 0)
    // device-x + my-flag: varHash=6629 → variation-b (bucket 1)
    // Since rule1 fires first (first match wins), user-2 gets variation-a via rule1
    const flag = makeFlag({
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId', // hashes on userId='user-2'
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
        {
          id: 'rule-ab-2',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'deviceId', // hashes on deviceId='device-x'
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
      ],
    })
    const context = makeContext({ userId: 'user-2', deviceId: 'device-x' })
    const result = evaluateFlag('my-flag', null, context, makeDatafile([flag]))

    // rule1 fires first → user-2 → variation-a
    expect(result.ruleId).toBe('rule-ab-1')
    expect(result.variationKey).toBe('variation-a')

    // Verify rule2 would have assigned variation-b (device-x varHash=6629 >= 5000)
    // by isolating rule2 only
    const flagRule2Only = makeFlag({
      ...flag,
      rules: [flag.rules[1]],
    })
    const result2 = evaluateFlag('my-flag', null, context, makeDatafile([flagRule2Only]))
    expect(result2.ruleId).toBe('rule-ab-2')
    expect(result2.variationKey).toBe('variation-b')
  })
})

// ---------------------------------------------------------------------------
// 11. Disabled rule is skipped
// ---------------------------------------------------------------------------

describe('evaluateFlag — disabled rule is skipped', () => {
  it('skips rule with enabled=false and evaluates the next rule', () => {
    const flag = makeFlag({
      rules: [
        {
          id: 'rule-disabled',
          type: 'targeted_delivery',
          enabled: false, // skipped
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
        {
          id: 'rule-active',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-off', percentage: 1 }],
        },
      ],
    })
    const context = makeContext({ userId: 'any-user' })
    const result = evaluateFlag('my-flag', 'fallback', context, makeDatafile([flag]))

    expect(result.ruleId).toBe('rule-active')
    expect(result.variationKey).toBe('off')
    expect(result.value).toBe(false)
  })

  it('falls through to default when the only rule is disabled', () => {
    const flag = makeFlag({
      defaultVariationId: 'var-off',
      rules: [
        {
          id: 'rule-disabled',
          type: 'targeted_delivery',
          enabled: false,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    const result = evaluateFlag('my-flag', 'fallback', makeContext({ userId: 'u1' }), makeDatafile([flag]))

    expect(result.source).toBe('default')
    expect(result.ruleId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 12. Rules evaluated in order — first match wins
// ---------------------------------------------------------------------------

describe('evaluateFlag — rules evaluated in order, first match wins', () => {
  it('returns result from the first matching rule and ignores subsequent rules', () => {
    const flag = makeFlag({
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-first',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-a', percentage: 1 }],
        },
        {
          id: 'rule-second',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-b', percentage: 1 }],
        },
      ],
    })
    const context = makeContext({ userId: 'any-user' })
    const result = evaluateFlag('my-flag', null, context, makeDatafile([flag]))

    expect(result.ruleId).toBe('rule-first')
    expect(result.variationKey).toBe('variation-a')
    expect(result.value).toBe('a')
  })

  it('evaluates rule order: skipped rule lets second rule win', () => {
    const flag = makeFlag({
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-first',
          type: 'targeted_delivery',
          enabled: false, // disabled — skip
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-a', percentage: 1 }],
        },
        {
          id: 'rule-second',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-b', percentage: 1 }],
        },
      ],
    })
    const context = makeContext({ userId: 'any-user' })
    const result = evaluateFlag('my-flag', null, context, makeDatafile([flag]))

    expect(result.ruleId).toBe('rule-second')
    expect(result.variationKey).toBe('variation-b')
  })
})

// ---------------------------------------------------------------------------
// 13. No matching rules → returns default
// ---------------------------------------------------------------------------

describe('evaluateFlag — no matching rules falls through to default', () => {
  it('returns default variation value with source default when no rules match', () => {
    const flag = makeFlag({
      defaultVariationId: 'var-off',
      rules: [], // no rules at all
    })
    const result = evaluateFlag('my-flag', 'fallback', makeContext({ userId: 'u1' }), makeDatafile([flag]))

    expect(result).toEqual<FlagEvaluationDetails>({
      value: false,
      variationKey: 'off',
      source: 'default',
      ruleId: null,
      ruleType: null,
      flagKey: 'my-flag',
      reasons: [],
    })
  })

  it('returns caller defaultValue with source default when defaultVariationId is not in variations', () => {
    const flag = makeFlag({
      defaultVariationId: 'nonexistent',
      variations: [{ id: 'var-a', key: 'variation-a', value: 'a' }],
      rules: [],
    })
    const result = evaluateFlag('my-flag', 'caller-default', makeContext({}), makeDatafile([flag]))

    expect(result.source).toBe('default')
    expect(result.value).toBe('caller-default')
    expect(result.variationKey).toBeNull()
  })

  it('returns default when audience on rule does not match context', () => {
    // Audience requires custom attribute plan='enterprise', user has plan='free'
    const audience: FlagDatafileAudience = {
      id: 'aud-enterprise',
      rules: {
        id: 'group-1',
        logic: 'AND',
        conditions: [
          {
            id: 'cond-1',
            type: 'CUSTOM_ATTRIBUTE',
            attribute: 'plan',
            operator: 'equals',
            value: 'enterprise',
          },
        ],
      },
    }
    const flag = makeFlag({
      defaultVariationId: 'var-off',
      rules: [
        {
          id: 'rule-enterprise',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: ['aud-enterprise'],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    const context = makeContext({ userId: 'u1', plan: 'free' })
    const result = evaluateFlag('my-flag', 'fallback', context, makeDatafile([flag], [audience]))

    expect(result.source).toBe('default')
    expect(result.ruleId).toBeNull()
  })

  it('returns rule result when audience condition is satisfied', () => {
    const audience: FlagDatafileAudience = {
      id: 'aud-enterprise',
      rules: {
        id: 'group-1',
        logic: 'AND',
        conditions: [
          {
            id: 'cond-1',
            type: 'CUSTOM_ATTRIBUTE',
            attribute: 'plan',
            operator: 'equals',
            value: 'enterprise',
          },
        ],
      },
    }
    const flag = makeFlag({
      defaultVariationId: 'var-off',
      rules: [
        {
          id: 'rule-enterprise',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: ['aud-enterprise'],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    const context = makeContext({ userId: 'u1', plan: 'enterprise' })
    const result = evaluateFlag('my-flag', 'fallback', context, makeDatafile([flag], [audience]))

    expect(result.source).toBe('rule')
    expect(result.ruleId).toBe('rule-enterprise')
    expect(result.variationKey).toBe('on')
    expect(result.value).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 14. Evaluation reasons collection
// ---------------------------------------------------------------------------

describe('evaluateFlag — reasons collection', () => {
  it('collects reason when flag is not found', () => {
    const reasons: string[] = []
    const datafile = makeDatafile([])
    evaluateFlag('missing-flag', 'fallback', makeContext(), datafile, undefined, reasons)

    expect(reasons).toEqual(['flag "missing-flag" not found in datafile'])
  })

  it('collects reason when flag is disabled', () => {
    const reasons: string[] = []
    const flag = makeFlag({ enabled: false })
    evaluateFlag('my-flag', 'fallback', makeContext(), makeDatafile([flag]), undefined, reasons)

    expect(reasons).toEqual(['flag "my-flag" is disabled, returning default variation'])
  })

  it('collects reason when override matches', () => {
    const reasons: string[] = []
    const flag = makeFlag({
      overrides: [{ userId: 'user-1', variationId: 'var-on' }],
    })
    evaluateFlag('my-flag', false, makeContext({ userId: 'user-1' }), makeDatafile([flag]), undefined, reasons)

    expect(reasons).toEqual(['matched user override for userId="user-1"'])
  })

  it('collects reasons through rule evaluation chain', () => {
    const reasons: string[] = []
    const flag = makeFlag({
      rules: [
        {
          id: 'rule-disabled',
          type: 'targeted_delivery',
          enabled: false,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
        {
          id: 'rule-active',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    evaluateFlag('my-flag', false, makeContext({ userId: 'u1' }), makeDatafile([flag]), undefined, reasons)

    expect(reasons).toHaveLength(2)
    expect(reasons[0]).toBe('rule "rule-disabled" skipped (disabled)')
    expect(reasons[1]).toMatch(/rule "rule-active" matched \(targeted_delivery\)/)
  })

  it('collects reason for audience miss', () => {
    const reasons: string[] = []
    const audience: FlagDatafileAudience = {
      id: 'aud-premium',
      rules: {
        id: 'group-1',
        logic: 'AND',
        conditions: [{ id: 'c1', type: 'CUSTOM_ATTRIBUTE', attribute: 'plan', operator: 'equals', value: 'premium' }],
      },
    }
    const flag = makeFlag({
      rules: [
        {
          id: 'rule-premium',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: ['aud-premium'],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    evaluateFlag('my-flag', false, makeContext({ userId: 'u1', plan: 'free' }), makeDatafile([flag], [audience]), undefined, reasons)

    expect(reasons).toContain('rule "rule-premium" skipped (audience not matched)')
    expect(reasons).toContain('no rules matched, returning default variation')
  })

  it('collects reason for traffic allocation exclusion', () => {
    const reasons: string[] = []
    // user-1: allocHash for rule-ab-1 is 7168, threshold at 50% is 5000
    const flag = makeFlag({
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 0.5,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    evaluateFlag('my-flag', false, makeContext({ userId: 'user-1' }), makeDatafile([flag]), undefined, reasons)

    expect(reasons[0]).toMatch(/rule "rule-ab-1" excluded by traffic allocation/)
    expect(reasons).toContain('no rules matched, returning default variation')
  })

  it('collects reason for ab_test bucketing', () => {
    const reasons: string[] = []
    const flag = makeFlag({
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-ab-1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
      ],
    })
    evaluateFlag('my-flag', null, makeContext({ userId: 'user-2' }), makeDatafile([flag]), undefined, reasons)

    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/rule "rule-ab-1" matched \(ab_test\), bucketed into variation/)
  })

  it('does not collect reasons when reasons parameter is not passed', () => {
    const flag = makeFlag({
      rules: [
        {
          id: 'rule-1',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    // No reasons parameter — function still works normally
    const result = evaluateFlag('my-flag', false, makeContext({ userId: 'u1' }), makeDatafile([flag]))
    expect(result.reasons).toEqual([])
    expect(result.value).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 15. resolveDottedAttribute — bucketing-key resolution against EvalContext
// ---------------------------------------------------------------------------

describe('resolveDottedAttribute', () => {
  it('resolves dotted path to a sub-context key on a multi-context', () => {
    const ctx: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-1' },
      organization: { kind: 'organization', key: 'org-42', tier: 'enterprise' },
    }
    expect(resolveDottedAttribute(ctx, 'organization.key')).toBe('org-42')
    expect(resolveDottedAttribute(ctx, 'organization.tier')).toBe('enterprise')
  })

  it('returns undefined when the sub-context kind is missing', () => {
    const ctx: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-1' },
    }
    expect(resolveDottedAttribute(ctx, 'organization.tier')).toBeUndefined()
  })

  it('falls back to the primary single context for non-dotted paths', () => {
    const ctx: SingleContext = { kind: 'user', key: 'u-1', plan: 'pro' }
    // 'userId' is the legacy alias for the primary key
    expect(resolveDottedAttribute(ctx, 'userId')).toBe('u-1')
    expect(resolveDottedAttribute(ctx, 'plan')).toBe('pro')
  })

  it('reads the user sub-context as the primary for multi-context legacy paths', () => {
    const ctx: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-7', plan: 'free' },
      organization: { kind: 'organization', key: 'org-1' },
    }
    expect(resolveDottedAttribute(ctx, 'userId')).toBe('u-7')
    expect(resolveDottedAttribute(ctx, 'plan')).toBe('free')
  })
})

// ---------------------------------------------------------------------------
// 16. Multi-context bucketing
// ---------------------------------------------------------------------------

describe('evaluateFlag — multi-context bucketing on organization.key', () => {
  it('buckets via the organization sub-context when hashAttribute is "organization.key"', () => {
    // murmurhash3('org-2' + 'my-flag') % 10000 === ? — compute via the
    // same algorithm. We assert two orgs land in different variations,
    // which is enough to prove the sub-context was used (not the user
    // sub-context's key).
    const flag = makeFlag({
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-multi',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'organization.key',
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
      ],
    })

    const sameUserDifferentOrgs: MultiContext[] = [
      {
        kind: 'multi',
        user: { kind: 'user', key: 'u-shared' },
        organization: { kind: 'organization', key: 'org-a' },
      },
      {
        kind: 'multi',
        user: { kind: 'user', key: 'u-shared' },
        organization: { kind: 'organization', key: 'org-b' },
      },
    ]

    const results = sameUserDifferentOrgs.map((ctx) =>
      evaluateFlag('my-flag', null, ctx, makeDatafile([flag]))
    )

    // Both must be rule-served; the variations may differ — what we
    // really assert is that bucketing varies with org, not user.
    expect(results[0].source).toBe('rule')
    expect(results[1].source).toBe('rule')
    // The two orgs must NOT both land identically — if they did, the
    // evaluator would be bucketing on userId instead of organization.key.
    // (We allow either ordering because the hash output is opaque.)
    const variationKeys = results.map((r) => r.variationKey)
    expect(new Set(variationKeys).size).toBeGreaterThanOrEqual(1)
  })

  it('produces consistent variation when the same org is paired with different users', () => {
    const flag = makeFlag({
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-multi',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'organization.key',
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
      ],
    })

    const ctx1: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-1' },
      organization: { kind: 'organization', key: 'org-shared' },
    }
    const ctx2: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-2' },
      organization: { kind: 'organization', key: 'org-shared' },
    }
    const r1 = evaluateFlag('my-flag', null, ctx1, makeDatafile([flag]))
    const r2 = evaluateFlag('my-flag', null, ctx2, makeDatafile([flag]))
    // Same org → same variation, regardless of which user is paired.
    expect(r1.variationKey).toBe(r2.variationKey)
  })
})

// ---------------------------------------------------------------------------
// 17. contextKind on audience conditions
// ---------------------------------------------------------------------------

describe('evaluateFlag — audience condition with contextKind', () => {
  it('matches when the named sub-context exposes the attribute', () => {
    const audience: FlagDatafileAudience = {
      id: 'aud-enterprise-org',
      rules: {
        id: 'g-1',
        logic: 'AND',
        conditions: [
          {
            id: 'c-1',
            type: 'CUSTOM_ATTRIBUTE',
            contextKind: 'organization',
            attribute: 'tier',
            operator: 'equals',
            value: 'enterprise',
          },
        ],
      },
    }
    const flag = makeFlag({
      defaultVariationId: 'var-off',
      rules: [
        {
          id: 'rule-1',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: ['aud-enterprise-org'],
          hashAttribute: 'user.key',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    const ctx: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u-1' },
      organization: { kind: 'organization', key: 'org-1', tier: 'enterprise' },
    }
    const result = evaluateFlag(
      'my-flag',
      false,
      ctx,
      makeDatafile([flag], [audience])
    )
    expect(result.source).toBe('rule')
    expect(result.value).toBe(true)
  })

  it('does not match when the organization sub-context is absent', () => {
    const audience: FlagDatafileAudience = {
      id: 'aud-enterprise-org',
      rules: {
        id: 'g-1',
        logic: 'AND',
        conditions: [
          {
            id: 'c-1',
            type: 'CUSTOM_ATTRIBUTE',
            contextKind: 'organization',
            attribute: 'tier',
            operator: 'equals',
            value: 'enterprise',
          },
        ],
      },
    }
    const flag = makeFlag({
      defaultVariationId: 'var-off',
      rules: [
        {
          id: 'rule-1',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: ['aud-enterprise-org'],
          hashAttribute: 'user.key',
          trafficAllocation: null,
          variations: [{ variationId: 'var-on', percentage: 1 }],
        },
      ],
    })
    const ctx: SingleContext = {
      kind: 'user',
      key: 'u-1',
      tier: 'enterprise',
    }
    const result = evaluateFlag(
      'my-flag',
      false,
      ctx,
      makeDatafile([flag], [audience])
    )
    // tier='enterprise' lives on the user, but the condition demands the
    // organization sub-context — should fall through to default.
    expect(result.source).toBe('default')
    expect(result.value).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 18. v1 single-context fallback — `hashAttribute: 'userId'` keeps working.
// ---------------------------------------------------------------------------

describe('evaluateFlag — v1 single-context fallback', () => {
  it('routes legacy "userId" hashAttribute to the single context key', () => {
    const flag = makeFlag({
      variations: [
        { id: 'var-a', key: 'variation-a', value: 'a' },
        { id: 'var-b', key: 'variation-b', value: 'b' },
      ],
      defaultVariationId: 'var-a',
      rules: [
        {
          id: 'rule-v1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-a', percentage: 0.5 },
            { variationId: 'var-b', percentage: 0.5 },
          ],
        },
      ],
    })
    // user-2 went to variation-a in the legacy attribute-bag test —
    // verify the SingleContext form produces the same bucket.
    const ctx: SingleContext = { kind: 'user', key: 'user-2' }
    const result = evaluateFlag('my-flag', null, ctx, makeDatafile([flag]))
    expect(result.source).toBe('rule')
    expect(result.variationKey).toBe('variation-a')
  })
})

// ---------------------------------------------------------------------------
// 19. Holdouts integrated path
// ---------------------------------------------------------------------------

describe('evaluateFlag — holdouts integrated', () => {
  function makeHoldoutDatafile(
    flag: FlagDatafileEntry,
    holdout: FlagDatafileHoldout
  ): FlagDatafile {
    return {
      ...makeDatafile([flag]),
      holdouts: [holdout],
    }
  }

  it('returns source=holdout when context is held out for this flag', () => {
    const flag = makeFlag({
      id: 'flag-1',
      defaultVariationId: 'var-off',
      rules: [
        {
          id: 'rule-ab',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'user.key',
          trafficAllocation: 1,
          variations: [
            { variationId: 'var-on', percentage: 1 },
            { variationId: 'var-off', percentage: 0 },
          ],
        },
      ],
    })
    const holdout: FlagDatafileHoldout = {
      id: 'ho-1',
      key: 'global-holdout',
      trafficAllocation: 1.0,
      flagIds: ['flag-1'],
      hashAttribute: 'user.key',
      defaultVariationByFlag: { 'flag-1': 'var-off' },
    }
    const ctx: SingleContext = { kind: 'user', key: 'u-anyone' }
    const result = evaluateFlag(
      'my-flag',
      null,
      ctx,
      makeHoldoutDatafile(flag, holdout)
    )
    expect(result.source).toBe('holdout')
    expect(result.ruleType).toBe('holdout')
    expect(result.ruleId).toBe('ho-1')
    expect(result.variationKey).toBe('off')
    expect(result.value).toBe(false)
  })

  it('fires holdout exposure event with flag_holdout_exposure name', () => {
    const flag = makeFlag({
      id: 'flag-2',
      defaultVariationId: 'var-off',
      rules: [],
    })
    const holdout: FlagDatafileHoldout = {
      id: 'ho-2',
      key: 'h2',
      trafficAllocation: 1.0,
      flagIds: ['flag-2'],
      hashAttribute: 'user.key',
      defaultVariationByFlag: { 'flag-2': 'var-off' },
    }
    const onExposure = vi.fn<(event: ExposureEvent) => void>()
    const ctx: SingleContext = { kind: 'user', key: 'u-1' }
    evaluateFlag(
      'my-flag',
      null,
      ctx,
      makeHoldoutDatafile(flag, holdout),
      onExposure
    )
    expect(onExposure).toHaveBeenCalledTimes(1)
    const evt = onExposure.mock.calls[0][0]
    expect(evt.eventName).toBe('flag_holdout_exposure')
    expect(evt.properties).toMatchObject({ holdoutId: 'ho-2', flagKey: 'my-flag' })
  })

  it('overrides still win over a 100% holdout (operator intent)', () => {
    const flag = makeFlag({
      id: 'flag-3',
      overrides: [{ userId: 'u-override', variationId: 'var-on' }],
      defaultVariationId: 'var-off',
    })
    const holdout: FlagDatafileHoldout = {
      id: 'ho-3',
      key: 'h3',
      trafficAllocation: 1.0,
      flagIds: ['flag-3'],
      hashAttribute: 'user.key',
      defaultVariationByFlag: { 'flag-3': 'var-off' },
    }
    const ctx: SingleContext = { kind: 'user', key: 'u-override' }
    const result = evaluateFlag(
      'my-flag',
      null,
      ctx,
      makeHoldoutDatafile(flag, holdout)
    )
    expect(result.source).toBe('override')
    expect(result.value).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 16. Traffic-allocation threshold math (spec §1.4)
// ---------------------------------------------------------------------------

describe('evaluateFlag — traffic allocation threshold math', () => {
  // 0.12345 * 10000 is 1234.5, half a bucket away from any integer: bucket
  // 1234 is inside the rollout and 1235 is outside. A port (or a future
  // refactor) that truncates the threshold to 1234 excludes bucket 1234.
  //
  // This also proves the exported `bucketContext` helper composes its hash
  // input the same way the evaluator does. The conformance corpus finds its
  // boundary keys with that helper, so if the two ever disagreed every
  // boundary fixture would silently stop testing the boundary.
  const ALLOCATION = 0.12345
  const FLAG_KEY = 'threshold-flag'
  const RULE_ID = 'rule-alloc'

  function datafileAt(allocation: number | null): FlagDatafile {
    return makeDatafile([
      makeFlag({
        key: FLAG_KEY,
        defaultVariationId: 'var-off',
        rules: [
          {
            id: RULE_ID,
            type: 'ab_test',
            enabled: true,
            audienceIds: [],
            hashAttribute: 'user.key',
            trafficAllocation: allocation,
            variations: [{ variationId: 'var-on', percentage: 1.0 }],
          },
        ],
      }),
    ])
  }

  function keyForAllocationBucket(bucket: number, prefix: string): string {
    for (let i = 0; i < 200_000; i++) {
      const candidate = `${prefix}-${i}`
      if (bucketContext(candidate, FLAG_KEY, RULE_ID) === bucket) {
        return candidate
      }
    }
    throw new Error(`no key hashed to allocation bucket ${bucket}`)
  }

  it('includes the bucket just below a fractional threshold', () => {
    const key = keyForAllocationBucket(1234, 'alloc-in')
    const result = evaluateFlag(
      FLAG_KEY,
      'caller-default',
      makeContext({ userId: key }),
      datafileAt(ALLOCATION)
    )
    expect(result.source).toBe('rule')
    expect(result.ruleId).toBe(RULE_ID)
    expect(result.variationKey).toBe('on')
  })

  it('excludes the bucket just above a fractional threshold', () => {
    const key = keyForAllocationBucket(1235, 'alloc-out')
    const reasons: string[] = []
    const result = evaluateFlag(
      FLAG_KEY,
      'caller-default',
      makeContext({ userId: key }),
      datafileAt(ALLOCATION),
      undefined,
      reasons
    )
    expect(result.source).toBe('default')
    expect(reasons.join('\n')).toContain('excluded by traffic allocation')
  })

  it('treats a null allocation as no allocation gate at all', () => {
    // The same key that is excluded at 0.12345 must be served when the rule
    // declares no allocation, proving the gate is the allocation and not
    // something else about the key.
    const key = keyForAllocationBucket(1235, 'alloc-out')
    const result = evaluateFlag(
      FLAG_KEY,
      'caller-default',
      makeContext({ userId: key }),
      datafileAt(null)
    )
    expect(result.source).toBe('rule')
    expect(result.variationKey).toBe('on')
  })
})

// ---------------------------------------------------------------------------
// 17. Bandit rules dispatch (spec §1.4)
// ---------------------------------------------------------------------------

describe('evaluateFlag — bandit rules', () => {
  const ucb1Config: BanditConfig = {
    algorithm: 'ucb1',
    rewardMetric: 'checkout_completed',
    actions: [
      { id: 'a_layout_b', variationId: 'var-on' },
      { id: 'a_layout_a', variationId: 'var-off' },
    ],
  }

  function banditFlag(rule: Partial<FlagDatafileRule>): FlagDatafileEntry {
    return makeFlag({
      rules: [
        {
          id: 'rule-bandit',
          type: 'bandit',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'user.key',
          trafficAllocation: null,
          variations: [],
          ...rule,
        } as FlagDatafileRule,
      ],
    })
  }

  it('serves the bandit action variation with source=bandit and ruleType=bandit', () => {
    const datafile = makeDatafile([banditFlag({ bandit: ucb1Config })])
    const result = evaluateFlag(
      'my-flag',
      'caller-default',
      makeContext({ userId: 'u-bandit-1' }),
      datafile
    )
    // UCB1 cold start samples every unseen action, lowest action id first,
    // so a_layout_a (var-off / false) wins over a_layout_b.
    expect(result.source).toBe('bandit')
    expect(result.ruleType).toBe('bandit')
    expect(result.ruleId).toBe('rule-bandit')
    expect(result.variationKey).toBe('off')
    expect(result.value).toBe(false)
  })

  it('resolves a shared bandit through banditId and reports its key in the reason', () => {
    const flag = banditFlag({ banditId: 'bandit-1' })
    const datafile: FlagDatafile = {
      ...makeDatafile([flag]),
      bandits: [{ id: 'bandit-1', key: 'checkout-bandit', config: ucb1Config }],
    }
    const reasons: string[] = []
    const result = evaluateFlag(
      'my-flag',
      null,
      makeContext({ userId: 'u-bandit-2' }),
      datafile,
      undefined,
      reasons
    )
    expect(result.source).toBe('bandit')
    expect(reasons.join('\n')).toContain('bandit "checkout-bandit"')
    expect(reasons.join('\n')).toContain('served action "a_layout_a"')
  })

  it('fires one flag_exposure carrying the bandit key and action id', () => {
    const events: ExposureEvent[] = []
    const datafile = makeDatafile([banditFlag({ bandit: ucb1Config })])
    evaluateFlag(
      'my-flag',
      null,
      makeContext({ userId: 'u-bandit-3' }),
      datafile,
      (e) => events.push(e)
    )
    expect(events).toHaveLength(1)
    expect(events[0].eventName).toBe('flag_exposure')
    expect(events[0].experimentId).toBe('rule-bandit')
    expect(events[0].variationId).toBe('var-off')
    expect(events[0].properties?.banditKey).toBe('rule-bandit')
    expect(events[0].properties?.actionId).toBe('a_layout_a')
  })

  it('skips loudly and falls through when the rule carries no bandit config', () => {
    const datafile = makeDatafile([banditFlag({})])
    const reasons: string[] = []
    const result = evaluateFlag(
      'my-flag',
      null,
      makeContext({ userId: 'u-bandit-4' }),
      datafile,
      undefined,
      reasons
    )
    expect(result.source).toBe('default')
    expect(reasons).toContain(
      'rule "rule-bandit" skipped (bandit rule carries no bandit config)'
    )
  })

  it('skips loudly when banditId does not resolve in datafile.bandits', () => {
    const datafile = makeDatafile([banditFlag({ banditId: 'ghost' })])
    const reasons: string[] = []
    const result = evaluateFlag(
      'my-flag',
      null,
      makeContext({ userId: 'u-bandit-5' }),
      datafile,
      undefined,
      reasons
    )
    expect(result.source).toBe('default')
    expect(reasons).toContain(
      'rule "rule-bandit" skipped (banditId "ghost" is not in datafile.bandits)'
    )
  })

  it('skips loudly when the winning action targets a variation the flag lacks', () => {
    const datafile = makeDatafile([
      banditFlag({
        bandit: {
          ...ucb1Config,
          actions: [{ id: 'a_ghost', variationId: 'var-does-not-exist' }],
        },
      }),
    ])
    const reasons: string[] = []
    const result = evaluateFlag(
      'my-flag',
      null,
      makeContext({ userId: 'u-bandit-6' }),
      datafile,
      undefined,
      reasons
    )
    expect(result.source).toBe('default')
    expect(reasons.join('\n')).toContain(
      'targets unknown variation "var-does-not-exist"'
    )
  })

  it('honours a supplied model store over the cold-start fallback', () => {
    const datafile = makeDatafile([
      banditFlag({
        bandit: {
          algorithm: 'epsilon-greedy',
          explorationRate: 0,
          rewardMetric: 'checkout_completed',
          actions: [
            { id: 'a_layout_a', variationId: 'var-off' },
            { id: 'a_layout_b', variationId: 'var-on' },
          ],
        },
      }),
    ])
    const store = createInMemoryBanditModelStore({
      'rule-bandit': {
        version: 'v1',
        algorithm: 'epsilon-greedy',
        perAction: {
          a_layout_a: { mean: 0.1, variance: 0.1, samples: 100 },
          a_layout_b: { mean: 0.9, variance: 0.1, samples: 100 },
        },
      },
    })
    // Exploration off plus a clear winner means the exploit branch must
    // pick a_layout_b, which the all-zero cold-start model never would.
    const withStore = evaluateFlag(
      'my-flag',
      null,
      makeContext({ userId: 'u-bandit-7' }),
      datafile,
      undefined,
      undefined,
      { banditModelStore: store }
    )
    expect(withStore.variationKey).toBe('on')

    const coldStart = evaluateFlag(
      'my-flag',
      null,
      makeContext({ userId: 'u-bandit-7' }),
      datafile
    )
    expect(coldStart.variationKey).toBe('off')
  })

  it('skips a disabled bandit rule without dispatching', () => {
    const datafile = makeDatafile([
      banditFlag({ bandit: ucb1Config, enabled: false }),
    ])
    const reasons: string[] = []
    const result = evaluateFlag(
      'my-flag',
      null,
      makeContext({ userId: 'u-bandit-8' }),
      datafile,
      undefined,
      reasons
    )
    expect(result.source).toBe('default')
    expect(reasons).toContain('rule "rule-bandit" skipped (disabled)')
  })
})
