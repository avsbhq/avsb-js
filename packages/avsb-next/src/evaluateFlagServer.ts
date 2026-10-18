// RSC-safe stateless flag evaluator.
// No client state, no imports from browser packages, no 'use client'.

import type { AvsbFlagKey, FlagDatafile, EvalContext, Flag, RuleType } from '@avsbhq/core'
import {
  toLegacyEvalContext,
  createFlag,
  notFoundFlag,
  mapLegacySource,
} from '@avsbhq/core'
import { evaluateFlag } from '@avsbhq/core/engine'

/**
 * Evaluate a single flag against a pre-fetched datafile.
 *
 * Stateless: no polling, no tracker, no sticky buckets. Intended for use
 * inside RSCs and server actions where a full SDK client is unnecessary.
 *
 * @param datafile     - The FlagDatafile obtained via `getDatafile`.
 * @param ctx          - The evaluation context (user, org, or multi-context).
 * @param flagKey      - The flag to evaluate.
 * @param defaultValue - Returned when the flag is not found or disabled.
 */
export function evaluateFlagServer<T>(
  datafile: FlagDatafile,
  ctx: EvalContext,
  flagKey: AvsbFlagKey,
  defaultValue: T
): Flag<T> {
  const legacy = toLegacyEvalContext(ctx)

  const result = evaluateFlag(
    flagKey,
    defaultValue,
    legacy,
    datafile,
    undefined, // no exposure event callback — stateless evaluator
    []
  )

  if (result.source === 'not_found') {
    return notFoundFlag(defaultValue, `flag "${flagKey}" not found in datafile`)
  }

  return createFlag<T>({
    value: (result.value ?? defaultValue) as T,
    variationKey: result.variationKey,
    source: mapLegacySource(
      // FlagEvaluationDetails.source is a union of legacy strings
      result.source as Parameters<typeof mapLegacySource>[0]
    ),
    ruleId: result.ruleId,
    ruleType: result.ruleType as RuleType | null,
    reasons: result.reasons,
    evaluatedAt: Date.now(),
    durationMicros: 0,
  })
}
