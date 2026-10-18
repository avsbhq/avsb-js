/**
 * Engine subpath. Direct access to evaluator primitives, bypassing the
 * lifecycle, tracker, and override system of the high-level client classes.
 *
 * Most consumers should NOT import from here. Use `@avsbhq/browser` (browser),
 * `@avsbhq/node` (server), or one of the framework adapters instead.
 *
 * Everything exported here is a real implementation. Placeholder stubs that
 * returned constants (`isHeldOut` always false, a second `evaluateBandit`
 * that returned the first action) were deleted in the SDK/API DX overhaul:
 * a port author following them wrote a passing test against a lie.
 */

export { evaluateFlag } from './evaluate'
export type { EvaluateFlagOptions } from './evaluate'
export { evaluateAudience, evaluateGroup, evaluateCondition } from './audience'
export { murmurhash3 } from './hash'
export { buildExposureAttributes } from './exposureAttributes'

/** Holdout classification, as the evaluator itself calls it (§8.2). */
export { evaluateHoldout } from './holdouts'
export type { HoldoutEvaluation } from './holdouts'

/**
 * Bandit action selection, as the evaluator itself calls it: the real
 * epsilon-greedy / Thompson / UCB1 implementations, seeded from
 * murmurhash3 so a `(banditKey, context)` pair is reproducible.
 */
export {
  evaluateBandit,
  createInMemoryBanditModelStore,
  seededGaussian,
} from './bandits'
export type {
  BanditModel,
  BanditModelStore,
  BanditPerActionStats,
} from './bandits'

import { murmurhash3 as _murmurhash3 } from './hash'

/**
 * TRAFFIC-ALLOCATION bucket for a context+rule pair, in `[0, 10_000)`:
 * `murmurhash3(bucketKey + flagKey + '__' + ruleId) % 10_000`. Compared
 * against `trafficAllocation * 10_000` to decide whether the context is
 * inside the rollout at all.
 *
 * This is only one of the two hashes an ab_test rule computes. The
 * variation assignment uses `assignmentBucket` below, which deliberately
 * omits the rule id so a context keeps its variation when the rollout
 * percentage changes.
 *
 * Exposed for parity with the per-language SDK conformance suite.
 */
export function bucketContext(
  bucketKey: string,
  flagKey: string,
  ruleId: string
): number {
  return _murmurhash3(bucketKey + flagKey + '__' + ruleId) % 10_000
}

/**
 * VARIATION-ASSIGNMENT bucket in `[0, 10_000)`:
 * `murmurhash3(bucketKey + flagKey) % 10_000`. Walked against the
 * rule's cumulative variation percentages (`bucket < cumulative`).
 *
 * Exposed for parity with the per-language SDK conformance suite: a port
 * that hashes the rule id in here will assign every context to a new
 * variation the first time a rollout percentage is edited.
 */
export function assignmentBucket(bucketKey: string, flagKey: string): number {
  return _murmurhash3(bucketKey + flagKey) % 10_000
}

/**
 * HOLDOUT bucket in `[0, 10_000)`:
 * `murmurhash3(holdoutKey + ':' + bucketKey) % 10_000`. Note the colon
 * separator and the key-first order, both different from the flag
 * hashes above; this is what makes one holdout classify a context
 * identically across every flag participating in it.
 */
export function holdoutBucket(holdoutKey: string, bucketKey: string): number {
  return _murmurhash3(holdoutKey + ':' + bucketKey) % 10_000
}
