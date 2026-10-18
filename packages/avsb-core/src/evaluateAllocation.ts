import type { FlagDatafileEntry, FlagDatafileRule } from './types'
import { murmurhash3 } from './hash'

// Variation lookup and the traffic-allocation math shared by every rule type.
// Split out of evaluate.ts (FU-31); evaluateFlag and evaluateRule are the only
// callers, and the package entry exports neither helper.

export function getVariationValue(
  flag: FlagDatafileEntry,
  variationId: string
): { value: unknown; key: string } | null {
  const variation = flag.variations.find((v) => v.id === variationId)
  if (!variation) return null
  return { value: variation.value, key: variation.key }
}

/**
 * The traffic-allocation gate, shared by `ab_test` and `targeted_delivery`
 * rules. Returns the exclusion reason when the context falls outside the
 * rule's rollout, or null when it is inside (or the rule declares none).
 *
 * One hash input for both rule types, `hashValue + flagKey + '__' + ruleId`,
 * so a visitor's rollout membership is the same in every SDK and does not
 * change if a rule's type does.
 *
 * Threshold math is a FLOAT comparison against the raw product, never a
 * truncated or rounded integer (spec §1.4). A 0.12345 rollout puts the
 * threshold at 1234.5: bucket 1234 is inside it, while a port that
 * truncates the threshold to 1234 excludes that context and diverges.
 * Boundary fixtures in the conformance corpus lock this at fractional and
 * at integer thresholds, for both rule types.
 *
 * `null` means no gate. A field missing from an old datafile (undefined)
 * also serves everyone: the product is NaN and `>=` against NaN is false.
 */
export function allocationExclusion(
  rule: FlagDatafileRule,
  hashValue: string,
  flagKey: string
): string | null {
  if (rule.trafficAllocation === null) return null
  const allocHash = murmurhash3(hashValue + flagKey + '__' + rule.id) % 10000
  const threshold = rule.trafficAllocation * 10000
  if (allocHash >= threshold) {
    return `rule "${rule.id}" excluded by traffic allocation (hash ${allocHash} >= threshold ${threshold})`
  }
  return null
}
