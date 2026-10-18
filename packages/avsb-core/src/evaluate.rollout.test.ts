/**
 * Targeted delivery rollouts (N1-1, production QA 2026-10-01).
 *
 * A TARGETED_DELIVERY rule with `trafficAllocation: 0.3` used to serve 100
 * percent of its audience in every SDK, because the evaluator only applied
 * the allocation inside `case 'ab_test'`. These tests lock the fix: the same
 * gate, the same hash input, and the same float threshold as an ab_test rule.
 */
import { evaluateFlag } from './evaluate'
import { bucketContext } from './engine'
import type {
  FlagDatafile,
  FlagDatafileAudience,
  FlagDatafileRule,
  ExposureEvent,
} from './types'

const FLAG_KEY = 'rollout_feature'
const RULE_ID = 'rule_rollout'
const USERS = 10_000

function tdRule(
  trafficAllocation: number | null,
  overrides: Partial<FlagDatafileRule> = {}
): FlagDatafileRule {
  return {
    id: RULE_ID,
    type: 'targeted_delivery',
    enabled: true,
    audienceIds: [],
    hashAttribute: 'user.key',
    trafficAllocation,
    variations: [{ variationId: 'var_on', percentage: 1 }],
    ...overrides,
  }
}

function datafileWith(
  rules: FlagDatafileRule[],
  audiences: FlagDatafileAudience[] = []
): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'sdk_test_rolloutfixture00001',
    environmentKey: 'test',
    publishedAt: '2026-10-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.test.invalid',
    flags: [
      {
        id: 'flag_rollout',
        key: FLAG_KEY,
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'var_off',
        variations: [
          { id: 'var_off', key: 'off', value: false },
          { id: 'var_on', key: 'on', value: true },
          { id: 'var_fallback', key: 'fallback', value: true },
        ],
        overrides: [],
        rules,
      },
    ],
    audiences,
  }
}

const userKey = (i: number): string => `user-${i}`

/** How many of the first `count` users the datafile serves the rule to. */
function servedCount(datafile: FlagDatafile, count = USERS): number {
  let served = 0
  for (let i = 0; i < count; i++) {
    const result = evaluateFlag(FLAG_KEY, false, { kind: 'user', key: userKey(i) }, datafile)
    if (result.ruleId === RULE_ID) served += 1
  }
  return served
}

function keyForAllocationBucket(bucket: number, prefix: string): string {
  for (let i = 0; i < 200_000; i++) {
    const candidate = `${prefix}-${i}`
    if (bucketContext(candidate, FLAG_KEY, RULE_ID) === bucket) return candidate
  }
  throw new Error(`no key hashed to allocation bucket ${bucket}`)
}

describe('evaluateFlag: targeted delivery rollout share', () => {
  it('serves a 30 percent rule to about 30 percent of 10,000 users', () => {
    const served = servedCount(datafileWith([tdRule(0.3)]))
    // Binomial sd at n=10,000, p=0.3 is about 46, so this window is over 3 sd.
    expect(served).toBeGreaterThanOrEqual(2850)
    expect(served).toBeLessThanOrEqual(3150)
  })

  it('serves a null allocation to everyone, exactly as before the fix', () => {
    expect(servedCount(datafileWith([tdRule(null)]), 2000)).toBe(2000)
  })

  it('serves a 1.0 allocation to everyone and a 0 allocation to no one', () => {
    expect(servedCount(datafileWith([tdRule(1)]), 2000)).toBe(2000)
    expect(servedCount(datafileWith([tdRule(0)]), 2000)).toBe(0)
  })

  it('keeps everyone already in a rollout when it grows from 5 to 30 percent', () => {
    const small = datafileWith([tdRule(0.05)])
    const large = datafileWith([tdRule(0.3)])
    for (let i = 0; i < 2000; i++) {
      const ctx = { kind: 'user', key: userKey(i) }
      if (evaluateFlag(FLAG_KEY, false, ctx, small).ruleId !== RULE_ID) continue
      expect(evaluateFlag(FLAG_KEY, false, ctx, large).ruleId).toBe(RULE_ID)
    }
  })
})

describe('evaluateFlag: targeted delivery rollout membership', () => {
  it('uses the ab_test allocation hash input, so both rule types agree per visitor', () => {
    const asTargeted = datafileWith([tdRule(0.3)])
    const asAbTest = datafileWith([
      tdRule(0.3, { type: 'ab_test', variations: [{ variationId: 'var_on', percentage: 1 }] }),
    ])
    for (let i = 0; i < 2000; i++) {
      const ctx = { kind: 'user', key: userKey(i) }
      const inRollout = bucketContext(userKey(i), FLAG_KEY, RULE_ID) < 3000
      expect(evaluateFlag(FLAG_KEY, false, ctx, asTargeted).ruleId === RULE_ID).toBe(inRollout)
      expect(evaluateFlag(FLAG_KEY, false, ctx, asAbTest).ruleId === RULE_ID).toBe(inRollout)
    }
  })

  it('compares against the raw float threshold: bucket 1234 is in a 0.12345 rollout', () => {
    const datafile = datafileWith([tdRule(0.12345)])
    const inside = keyForAllocationBucket(1234, 'td-in')
    const outside = keyForAllocationBucket(1235, 'td-out')

    expect(evaluateFlag(FLAG_KEY, false, { kind: 'user', key: inside }, datafile).ruleId).toBe(
      RULE_ID
    )
    const reasons: string[] = []
    const result = evaluateFlag(
      FLAG_KEY,
      false,
      { kind: 'user', key: outside },
      datafile,
      undefined,
      reasons
    )
    expect(result.source).toBe('default')
    expect(reasons).toEqual([
      `rule "${RULE_ID}" excluded by traffic allocation (hash 1235 >= threshold 1234.5)`,
      'no rules matched, returning default variation',
    ])
  })

  it('lets a visitor outside the rollout fall through to the next rule', () => {
    const datafile = datafileWith([
      tdRule(0.3),
      tdRule(null, { id: 'rule_everyone', variations: [{ variationId: 'var_fallback', percentage: 1 }] }),
    ])
    const outside = keyForAllocationBucket(9000, 'td-next')
    const result = evaluateFlag(FLAG_KEY, false, { kind: 'user', key: outside }, datafile)
    expect(result.ruleId).toBe('rule_everyone')
    expect(result.variationKey).toBe('fallback')
  })

  it('still skips on an audience miss before the rollout is consulted', () => {
    const paid: FlagDatafileAudience = {
      id: 'aud_paid',
      rules: {
        id: 'g_root',
        logic: 'AND',
        conditions: [
          {
            id: 'c_plan',
            type: 'CUSTOM_ATTRIBUTE',
            attribute: 'plan',
            operator: 'equals',
            value: 'paid',
            contextKind: 'user',
          },
        ],
      },
    }
    const datafile = datafileWith([tdRule(1, { audienceIds: ['aud_paid'] })], [paid])
    const reasons: string[] = []
    const result = evaluateFlag(
      FLAG_KEY,
      false,
      { kind: 'user', key: 'free-user', plan: 'free' },
      datafile,
      undefined,
      reasons
    )
    expect(result.source).toBe('default')
    expect(reasons[0]).toBe(`rule "${RULE_ID}" skipped (audience not matched)`)
  })

  it('keeps a rule with no variations a silent skip, whatever its allocation', () => {
    const datafile = datafileWith([tdRule(0, { variations: [] })])
    const reasons: string[] = []
    evaluateFlag(FLAG_KEY, false, { kind: 'user', key: 'u1' }, datafile, undefined, reasons)
    expect(reasons).toEqual(['no rules matched, returning default variation'])
  })

  it('fires no exposure for a targeted delivery decision, rollout or not', () => {
    const onExposure = vi.fn<(event: ExposureEvent) => void>()
    const inside = keyForAllocationBucket(10, 'td-expo')
    const result = evaluateFlag(
      FLAG_KEY,
      false,
      { kind: 'user', key: inside },
      datafileWith([tdRule(0.3)]),
      onExposure
    )
    expect(result.ruleType).toBe('targeted_delivery')
    expect(onExposure).not.toHaveBeenCalled()
  })
})
