import type {
  BanditConfig,
  EvalContext,
  FlagDatafile,
  FlagDatafileAudience,
  FlagDatafileEntry,
  FlagDatafileRule,
  FlagEvaluationDetails,
  ExposureEvent,
} from './types'
import { murmurhash3 } from './hash'
import { evaluateAudience } from './audience'
import { evaluateBandit } from './bandits'
import type { BanditModel, BanditModelStore } from './bandits'
import { buildExposureAttributesFor, resolveDottedAttribute } from './evaluatorContext'
import { allocationExclusion, getVariationValue } from './evaluateAllocation'

// One rule of a flag, evaluated against one context: step 5 of evaluateFlag,
// split out of evaluate.ts (FU-31). evaluateFlag walks the rules in order and
// stops at the first one that answers.

/** Options bag for `evaluateFlag`. Every member is optional. */
export interface EvaluateFlagOptions {
  /**
   * Bandit model store consulted for `bandit`-typed rules. Models are
   * client-layer state (they are learned, not published in the datafile),
   * so when no store is supplied the evaluator falls back to a
   * deterministic cold-start model built from the datafile's bandit
   * config alone. That fallback is what the conformance corpus locks:
   * every port must produce the same action for the same datafile and
   * context with no model present.
   */
  banditModelStore?: BanditModelStore
}

/** Model version reported for the store-free cold-start fallback. */
const COLD_START_MODEL_VERSION = 'cold-start'

/**
 * Resolve the bandit a `bandit`-typed rule points at. A shared
 * `banditId` (joined against `datafile.bandits`) wins over an inline
 * `rule.bandit`, and the resolved key is what addresses the model store:
 * the shared entry's `key`, or the rule's own id for an inline config.
 */
function resolveRuleBandit(
  rule: FlagDatafileRule,
  datafile: FlagDatafile
): { key: string; config: BanditConfig } | null {
  if (rule.banditId) {
    const shared = (datafile.bandits ?? []).find((b) => b.id === rule.banditId)
    if (!shared) return null
    return { key: shared.key, config: shared.config }
  }
  if (rule.bandit) return { key: rule.id, config: rule.bandit }
  return null
}

/**
 * Store that hands back a zero-observation model for any bandit key, so
 * the bandit algorithms run their documented cold-start policies instead
 * of the rule being silently skipped (spec §1.2 silent-drop ban).
 */
function coldStartBanditStore(config: BanditConfig): BanditModelStore {
  const model: BanditModel = {
    version: COLD_START_MODEL_VERSION,
    algorithm: config.algorithm,
    perAction: {},
  }
  return {
    getModel: () => model,
    updateModel: () => {
      // Nothing to persist: the cold-start model is derived, not stored.
    },
  }
}

/** Everything one rule evaluation reads. Built once per evaluateFlag call. */
export interface RuleEvaluationInput {
  rule: FlagDatafileRule
  flag: FlagDatafileEntry
  flagKey: string
  defaultValue: unknown
  ctx: EvalContext
  datafile: FlagDatafile
  audienceMap: Map<string, FlagDatafileAudience>
  onExposure?: (event: ExposureEvent) => void
  reasons?: string[]
  options?: EvaluateFlagOptions
}

/**
 * Evaluate one rule. Returns the decision when the rule matches, or null when
 * evaluation falls through to the next rule (disabled, audience not matched,
 * outside the allocation, or nothing to serve). Every skip records its reason.
 */
export function evaluateRule(input: RuleEvaluationInput): FlagEvaluationDetails | null {
  const {
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
  } = input

  if (!rule.enabled) {
    reasons?.push(`rule "${rule.id}" skipped (disabled)`)
    return null
  }

  // Resolve this rule's bucketing key. v1 datafiles persist
  // `hashAttribute: 'userId'` and expect the primary context's key.
  // v2 datafiles persist dotted paths like `'user.key'` or
  // `'organization.tier'`.
  const hashPath = rule.hashAttribute || 'userId'
  const resolved = resolveDottedAttribute(ctx, hashPath)
  const hashValue = resolved === undefined || resolved === null
    ? ''
    : String(resolved)

  // a. CHECK AUDIENCE
  if (rule.audienceIds.length > 0) {
    const matched = rule.audienceIds.some((id) => {
      const audience = audienceMap.get(id)
      if (!audience) return false
      // Commerce money conditions need the project currency exponent
      // from the datafile (C5); default handling lives in the evaluator.
      return evaluateAudience(audience, ctx, {
        currencyExponent: datafile.currencyExponent,
      })
    })
    if (!matched) {
      reasons?.push(`rule "${rule.id}" skipped (audience not matched)`)
      return null
    }
  }

  // b. EVALUATE BY TYPE
  switch (rule.type) {
    case 'targeted_delivery': {
      if (rule.variations.length === 0) return null
      // A targeted delivery rule below 100 percent is a ROLLOUT: serve
      // the variation to that share of the audience, and let everyone
      // else fall through to the next rule, exactly as an ab_test rule's
      // allocation does (N1-1). The check sits after the empty-variations
      // skip, so a rule with nothing to serve stays a silent skip.
      const tdExclusion = allocationExclusion(rule, hashValue, flagKey)
      if (tdExclusion) {
        reasons?.push(tdExclusion)
        return null
      }
      const targetVar = getVariationValue(
        flag,
        rule.variations[0].variationId
      )
      reasons?.push(`rule "${rule.id}" matched (targeted_delivery), serving variation "${targetVar?.key}"`)
      return {
        value: targetVar ? targetVar.value : defaultValue,
        variationKey: targetVar ? targetVar.key : null,
        source: 'rule',
        ruleId: rule.id,
        ruleType: 'targeted_delivery',
        flagKey,
        reasons: reasons ?? [],
      }
    }

    case 'ab_test': {
      // Check traffic allocation (see `allocationExclusion` for the
      // float-threshold rule every port must copy).
      const abExclusion = allocationExclusion(rule, hashValue, flagKey)
      if (abExclusion) {
        reasons?.push(abExclusion)
        return null
      }

      // Assign variation
      const hash = murmurhash3(hashValue + flagKey) % 10000
      let cumulative = 0
      for (const rv of rule.variations) {
        cumulative += rv.percentage * 10000
        if (hash < cumulative) {
          const expVar = getVariationValue(flag, rv.variationId)

          // Queue exposure event
          if (onExposure && expVar) {
            const isBrowser =
              typeof window !== 'undefined' &&
              typeof location !== 'undefined'
            const exposureAttributes = buildExposureAttributesFor(
              ctx,
              datafile
            )
            onExposure({
              visitorId: hashValue,
              experimentId: rule.id,
              variationId: rv.variationId,
              eventName: 'flag_exposure',
              revenue: null,
              timestamp: Date.now(),
              pageUrl: isBrowser ? location.href : '',
              properties: { flagKey, flagId: flag.id },
              ...(exposureAttributes ? { attributes: exposureAttributes } : {}),
            })
          }

          reasons?.push(`rule "${rule.id}" matched (ab_test), bucketed into variation "${expVar?.key}" (hash ${hash}/${cumulative})`)
          return {
            value: expVar ? expVar.value : defaultValue,
            variationKey: expVar ? expVar.key : null,
            source: 'rule',
            ruleId: rule.id,
            ruleType: 'ab_test',
            flagKey,
            reasons: reasons ?? [],
          }
        }
      }
      return null
    }

    case 'bandit': {
      // Bandit rules dispatch through the shared bandit engine (spec
      // §1.4). Every exit below appends a reason: a bandit rule must
      // never disappear from the decision trail (spec §1.2).
      const bandit = resolveRuleBandit(rule, datafile)
      if (!bandit) {
        reasons?.push(
          rule.banditId
            ? `rule "${rule.id}" skipped (banditId "${rule.banditId}" is not in datafile.bandits)`
            : `rule "${rule.id}" skipped (bandit rule carries no bandit config)`
        )
        return null
      }
      if (bandit.config.actions.length === 0) {
        reasons?.push(
          `rule "${rule.id}" skipped (bandit "${bandit.key}" declares no actions)`
        )
        return null
      }

      const store =
        options?.banditModelStore ?? coldStartBanditStore(bandit.config)
      const decision = evaluateBandit(
        bandit.key,
        bandit.config,
        ctx,
        store
      )
      if (!decision) {
        reasons?.push(
          `rule "${rule.id}" skipped (bandit "${bandit.key}" has no model in the supplied store)`
        )
        return null
      }

      const banditVar = getVariationValue(
        flag,
        decision.action.variationId
      )
      if (!banditVar) {
        reasons?.push(
          `rule "${rule.id}" skipped (bandit "${bandit.key}" action "${decision.action.id}" targets unknown variation "${decision.action.variationId}")`
        )
        return null
      }

      if (onExposure) {
        const isBrowser =
          typeof window !== 'undefined' && typeof location !== 'undefined'
        const exposureAttributes = buildExposureAttributesFor(ctx, datafile)
        onExposure({
          visitorId: hashValue,
          experimentId: rule.id,
          variationId: decision.action.variationId,
          eventName: 'flag_exposure',
          revenue: null,
          timestamp: Date.now(),
          pageUrl: isBrowser ? location.href : '',
          properties: {
            flagKey,
            flagId: flag.id,
            banditKey: bandit.key,
            actionId: decision.action.id,
          },
          ...(exposureAttributes ? { attributes: exposureAttributes } : {}),
        })
      }

      reasons?.push(
        `rule "${rule.id}" matched (bandit "${bandit.key}"), served action "${decision.action.id}" into variation "${banditVar.key}"`
      )
      return {
        value: banditVar.value,
        variationKey: banditVar.key,
        source: 'bandit',
        ruleId: rule.id,
        ruleType: 'bandit',
        flagKey,
        reasons: reasons ?? [],
      }
    }

    default: {
      // Unknown rule type on the wire: name it rather than dropping it.
      reasons?.push(
        `rule "${rule.id}" skipped (unsupported rule type "${String(rule.type)}")`
      )
      return null
    }
  }
}
