import type {
  EvalContext,
  FlagDatafile,
  FlagDatafileHoldout,
} from './types'
import { murmurhash3 } from './hash'
// From its own module, not './evaluate': evaluate.ts imports this file, and
// importing back from it made the two modules a cycle.
import { resolveDottedAttribute } from './evaluatorContext'

export interface HoldoutEvaluation {
  /** True when the eval context is inside this holdout's traffic window. */
  heldOut: boolean
  /** Matched holdout, when one classified the context as held out. */
  holdout?: FlagDatafileHoldout
  /** Variation id served to held-out contexts for the requested flag. */
  variationId?: string
}

/**
 * Resolve the bucketing key for a holdout's `hashAttribute` against an
 * `EvalContext`. Returns the empty string when the requested kind/
 * attribute combo is absent — that gives a stable (deterministic)
 * classification rather than blowing up on missing data.
 */
function holdoutBucketKey(
  context: EvalContext,
  hashAttribute: string
): string {
  const value = resolveDottedAttribute(context, hashAttribute)
  if (value === undefined || value === null) return ''
  return String(value)
}

/**
 * Spec §8.2: holdouts + mutual exclusion.
 *
 * Walks the datafile's active holdouts; the first one that participates
 * in `flagId` and whose bucket lands inside its traffic-allocation
 * window classifies the context as held out for THIS flag. Bucketing is
 * `murmurhash3(holdoutKey + ':' + bucketingKey) % 10_000` so multiple
 * flags sharing a holdout get a consistent classification per context
 * (this is the mutual-exclusion guarantee).
 */
export function evaluateHoldout(
  context: EvalContext,
  flagId: string,
  datafile: FlagDatafile
): HoldoutEvaluation {
  const holdouts = datafile.holdouts
  // `Array.isArray`, not a truthiness check: a malformed datafile carrying
  // `holdouts: {}` must read as "no holdouts", never throw from a read.
  if (!Array.isArray(holdouts) || holdouts.length === 0) return { heldOut: false }

  for (const holdout of holdouts) {
    if (!holdout.flagIds.includes(flagId)) continue
    if (holdout.trafficAllocation <= 0) continue

    const bucketKey = holdoutBucketKey(context, holdout.hashAttribute)
    const hash = murmurhash3(holdout.key + ':' + bucketKey) % 10_000
    // Float comparison, never a truncation (spec §1.4 threshold math).
    // This used to floor the threshold, which put it one bucket out of
    // step with the ab_test allocation check in evaluate.ts: a 0.12345
    // holdout has a threshold of 1234.5, so bucket 1234 is inside the
    // window, but the floored form compared against 1234 and let that
    // context through. Every port compares the raw product.
    const threshold = holdout.trafficAllocation * 10_000
    if (hash >= threshold) continue

    const variationId = holdout.defaultVariationByFlag[flagId]
    return {
      heldOut: true,
      holdout,
      ...(variationId ? { variationId } : {}),
    }
  }

  return { heldOut: false }
}
