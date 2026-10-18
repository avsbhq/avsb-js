import type {
  EvalContext,
  FlagDatafile,
  FlagEvaluationDetails,
  ExposureEvent,
  LegacyEvalContext,
} from './types'
import { bucketingKey } from './context'
import { evaluateHoldout } from './holdouts'
import {
  buildExposureAttributesFor,
  fromLegacyEvalContext,
  isLegacyEvalContext,
  primaryContext,
  resolveDottedAttribute,
} from './evaluatorContext'
import { getVariationValue } from './evaluateAllocation'
import { evaluateRule, type EvaluateFlagOptions } from './evaluateRule'

// Re-exported from its old home: the package entry and the tests import it
// from './evaluate'.
export { resolveDottedAttribute }

// The options bag moved to ./evaluateRule with the rule loop (FU-31); this is
// still the path the engine entry and every caller import it from.
export type { EvaluateFlagOptions }

export function evaluateFlag(
  flagKey: string,
  defaultValue: unknown,
  context: EvalContext | LegacyEvalContext,
  datafile: FlagDatafile,
  onExposure?: (event: ExposureEvent) => void,
  reasons?: string[],
  options?: EvaluateFlagOptions
): FlagEvaluationDetails {
  // Normalise legacy-shape callers (browser/node/edge adapters that
  // still pass `toLegacyEvalContext(ctx)`) into the kinded EvalContext
  // shape the rest of this function expects. New callers pass
  // EvalContext directly and this is a no-op type-narrow.
  const ctx: EvalContext = isLegacyEvalContext(context)
    ? fromLegacyEvalContext(context)
    : context

  // 0. MALFORMED DATAFILE (N0-15). Reads never throw: a datafile whose
  //    `flags` is not an array (a hand-built bootstrap such as
  //    `{ flags: {} }`) answers like an unknown key instead of throwing a
  //    TypeError out of a request handler. The SDK clients refuse such a
  //    datafile before it gets here and say why (`datafileShapeProblem`);
  //    this guard is the last line for direct engine callers.
  if (!Array.isArray(datafile?.flags)) {
    reasons?.push(
      `flag "${flagKey}" cannot be evaluated: the datafile has no flags array`
    )
    return {
      value: defaultValue,
      variationKey: null,
      source: 'not_found',
      ruleId: null,
      ruleType: null,
      flagKey,
      reasons: reasons ?? [],
    }
  }

  // 1. FIND FLAG
  const flag = datafile.flags.find((f) => f.key === flagKey)
  if (!flag) {
    reasons?.push(`flag "${flagKey}" not found in datafile`)
    return {
      value: defaultValue,
      variationKey: null,
      source: 'not_found',
      ruleId: null,
      ruleType: null,
      flagKey,
      reasons: reasons ?? [],
    }
  }

  // 2. CHECK ENABLED
  if (!flag.enabled) {
    reasons?.push(`flag "${flagKey}" is disabled, returning default variation`)
    const defaultVar = getVariationValue(flag, flag.defaultVariationId)
    return {
      value: defaultVar ? defaultVar.value : defaultValue,
      variationKey: defaultVar ? defaultVar.key : null,
      source: 'disabled',
      ruleId: null,
      ruleType: null,
      flagKey,
      reasons: reasons ?? [],
    }
  }

  // 3. CHECK OVERRIDES — overrides match on the primary context's key
  //    (legacy "userId"). For multi-context evals the primary kind is
  //    `'user'` (or the first declared kind when no user is present).
  const primaryKey = bucketingKey(ctx, 'user') || (primaryContext(ctx)?.key ?? '')

  const override = flag.overrides.find((o) => o.userId === primaryKey)
  if (override) {
    reasons?.push(`matched user override for userId="${primaryKey}"`)
    const overrideVar = getVariationValue(flag, override.variationId)
    return {
      value: overrideVar ? overrideVar.value : defaultValue,
      variationKey: overrideVar ? overrideVar.key : null,
      source: 'override',
      ruleId: null,
      ruleType: null,
      flagKey,
      reasons: reasons ?? [],
    }
  }

  // 4. HOLDOUT CHECK — fires between overrides and the rules loop so
  //    runtime/datafile overrides still win (they're explicit operator
  //    intent), but every regular rule evaluation honours the holdout.
  const holdout = evaluateHoldout(ctx, flag.id, datafile)
  if (holdout.heldOut && holdout.holdout) {
    const targetVarId =
      holdout.variationId ?? flag.defaultVariationId
    const holdoutVar = getVariationValue(flag, targetVarId)

    if (onExposure) {
      const isBrowser =
        typeof window !== 'undefined' && typeof location !== 'undefined'
      const exposureAttributes = buildExposureAttributesFor(
        ctx,
        datafile
      )
      onExposure({
        visitorId: primaryKey,
        experimentId: holdout.holdout.id,
        variationId: targetVarId,
        eventName: 'flag_holdout_exposure',
        revenue: null,
        timestamp: Date.now(),
        pageUrl: isBrowser ? location.href : '',
        properties: {
          flagKey,
          flagId: flag.id,
          holdoutId: holdout.holdout.id,
          holdoutKey: holdout.holdout.key,
        },
        ...(exposureAttributes ? { attributes: exposureAttributes } : {}),
      })
    }

    reasons?.push(
      `held out by holdout "${holdout.holdout.key}", serving default variation "${holdoutVar?.key ?? targetVarId}"`
    )
    return {
      value: holdoutVar ? holdoutVar.value : defaultValue,
      variationKey: holdoutVar ? holdoutVar.key : null,
      source: 'holdout',
      ruleId: holdout.holdout.id,
      ruleType: 'holdout',
      flagKey,
      reasons: reasons ?? [],
    }
  }

  // Build audience lookup from datafile. A missing or malformed audiences
  // list means no audience can match, never a throw.
  const audiences = Array.isArray(datafile.audiences) ? datafile.audiences : []
  const audienceMap = new Map(audiences.map((a) => [a.id, a]))

  // 5. EVALUATE RULES (in order, first match wins). Each rule's body lives
  //    in ./evaluateRule; a null answer falls through to the next rule.
  for (const rule of flag.rules) {
    const decision = evaluateRule({
      rule,
      flag,
      flagKey,
      defaultValue,
      ctx,
      datafile,
      audienceMap,
      onExposure,
      reasons,
      options,
    })
    if (decision) return decision
  }

  // 6. DEFAULT
  reasons?.push('no rules matched, returning default variation')
  const defaultVar = getVariationValue(flag, flag.defaultVariationId)
  return {
    value: defaultVar ? defaultVar.value : defaultValue,
    variationKey: defaultVar ? defaultVar.key : null,
    source: 'default',
    ruleId: null,
    ruleType: null,
    flagKey,
    reasons: reasons ?? [],
  }
}
