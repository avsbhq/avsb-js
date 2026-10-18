// The decision core of AvsbServer: runtime override, then sticky bucket,
// then the shared engine, plus the manual exposure that replays a decision.
// Split out of AvsbServer.ts (FU-31).

import { evaluateFlag } from '@avsbhq/core/engine'
import type {
  EvalContext,
  ExposureEvent,
  RuleType,
  StickyAssignment,
} from '@avsbhq/core'
import {
  bucketingKey,
  mapLegacySource,
  privateAttributesFrom,
  toLegacyEvalContext,
} from '@avsbhq/core'
import { redactExposure } from '@avsbhq/utils/exposure'
import { emit } from './serverState'
import type { ServerState } from './serverState'
import { deliverExposure } from './serverTracking'
import type { EvalResult, LegacyUserContext } from './types'
import type { AvsbServer } from './AvsbServer'

/** Internal variation reference. */
export type VRef = { value: unknown; key: string; id: string }
type StickyResolution = { vref: VRef; assignment: StickyAssignment }

export function evaluateDecision(
  s: ServerState,
  flagKey: string,
  uc: LegacyUserContext,
  defaultValue: unknown
): EvalResult {
  const reasons: string[] = []

  // 1. Runtime override (per-context, then global).
  const overrideKey = s.overrides.resolve(flagKey, uc.userId)
  const rtOver = overrideKey ? findVariation(s, flagKey, overrideKey) : null
  if (rtOver) {
    reasons.push(`matched runtime override for flagKey="${flagKey}"`)
    return {
      value: rtOver.value,
      variationKey: rtOver.key,
      source: 'runtimeOverride',
      ruleId: null,
      ruleType: null,
      reasons,
    }
  }

  // 2. Sticky bucket. Deliberately ahead of the engine, so a stored
  //    assignment survives a rule edit (founder decision, spec §1.4).
  if (s.stickyBucketService) {
    const sticky = resolveStickyBucket(s, flagKey, uc.userId)
    if (sticky !== undefined) {
      reasons.push(`matched sticky bucket assignment for userId="${uc.userId}"`)
      if (!uc.suppressExposure) {
        fireExposureForStickyAssignment(s, flagKey, sticky, uc)
      }
      return {
        value: sticky.vref.value,
        variationKey: sticky.vref.key,
        source: 'sticky',
        ruleId: sticky.assignment.ruleId,
        ruleType: sticky.assignment.ruleType,
        reasons,
      }
    }
  }

  // 3. Shared engine evaluation.
  const legacyCtx = { attributes: { userId: uc.userId, ...uc.attributes } }
  const onExposure = uc.suppressExposure
    ? undefined
    : (event: ExposureEvent): void => {
        deliverExposure(s, redactExposure(event, uc.privateAttributes))
      }

  const r = evaluateFlag(
    flagKey,
    defaultValue,
    legacyCtx,
    // Callers check readiness first, so a datafile is loaded here.
    s.datafile!,
    onExposure,
    reasons
  )

  // Persist sticky assignments for ab_test rules only.
  if (
    s.stickyBucketService &&
    r.variationKey &&
    r.source === 'rule' &&
    r.ruleId &&
    r.ruleType === 'ab_test'
  ) {
    const v = findVariation(s, flagKey, r.variationKey)
    if (v) {
      s.stickyBucketService.save(uc.userId, flagKey, {
        variationId: v.id,
        ruleId: r.ruleId,
        ruleType: r.ruleType,
        assignedAt: Date.now(),
      })
    }
  }

  return {
    value: r.value,
    variationKey: r.variationKey,
    source: mapLegacySource(r.source as Parameters<typeof mapLegacySource>[0]),
    ruleId: r.ruleId,
    ruleType: r.ruleType as RuleType | null,
    reasons,
  }
}

export function buildLegacyContext(
  context: EvalContext,
  suppressExposure: boolean
): LegacyUserContext {
  const legacy = toLegacyEvalContext(context)
  const userId = (legacy.attributes['userId'] as string | undefined) ?? ''
  const privateAttrs = privateAttributesFrom(context)
  const { userId: _uid, ...rest } = legacy.attributes
  return {
    userId,
    attributes: rest,
    suppressExposure,
    privateAttributes: privateAttrs.size > 0 ? [...privateAttrs] : undefined,
  }
}

/** The body of `AvsbServer.manualExposure`. */
export function manualExposure(
  s: ServerState,
  server: AvsbServer,
  flagKey: string,
  context: EvalContext
): void {
  if (!server.isReady() || !s.datafile || !s.tracker) return
  const legacyCtx = buildLegacyContext(context, true)
  const result = evaluateDecision(s, flagKey, legacyCtx, undefined)
  if (result.source !== 'rule' || !result.ruleId || !result.variationKey) return
  if (result.ruleType !== 'ab_test' && result.ruleType !== 'targeted_delivery') return

  const flag = s.datafile.flags.find((f) => f.key === flagKey)
  if (!flag) return
  const variation = flag.variations.find((v) => v.key === result.variationKey)
  if (!variation) return

  deliverExposure(s, {
    visitorId: bucketingKey(context),
    experimentId: result.ruleId,
    variationId: variation.id,
    eventName: 'flag_exposure',
    revenue: null,
    timestamp: Date.now(),
    pageUrl: '',
    properties: { flagKey, flagId: flag.id, manuallyFired: true },
  })
}

// ---------------------------------------------------------------------------
// Sticky helpers
// ---------------------------------------------------------------------------

function resolveStickyBucket(
  s: ServerState,
  flagKey: string,
  userId: string
): StickyResolution | undefined {
  if (!s.stickyBucketService || !s.datafile) return undefined
  const assignment = s.stickyBucketService.lookup(userId, flagKey)
  if (!assignment) return undefined
  const flag = s.datafile.flags.find((f) => f.key === flagKey)
  if (!flag) return undefined
  const v = flag.variations.find((x) => x.id === assignment.variationId)
  if (!v) return undefined
  return { vref: { value: v.value, key: v.key, id: v.id }, assignment }
}

export function findVariation(
  s: ServerState,
  flagKey: string,
  variationKey: string
): VRef | null {
  if (!s.datafile) return null
  const flag = s.datafile.flags.find((f) => f.key === flagKey)
  if (!flag) return null
  const v = flag.variations.find((x) => x.key === variationKey)
  if (!v) return null
  return { value: v.value, key: v.key, id: v.id }
}

function fireExposureForStickyAssignment(
  s: ServerState,
  flagKey: string,
  sticky: StickyResolution,
  uc: LegacyUserContext
): void {
  if (!s.tracker || !s.datafile) return
  const flag = s.datafile.flags.find((f) => f.key === flagKey)
  if (!flag) return
  const rule = flag.rules.find((r) => r.id === sticky.assignment.ruleId)

  if (!rule || !rule.variations.some((rv) => rv.variationId === sticky.vref.id)) {
    s.logger.warn(
      'Sticky assignment references a rule no longer matching the datafile',
      {
        flagKey,
        userId: uc.userId,
        assignedRuleId: sticky.assignment.ruleId,
        assignedVariationId: sticky.vref.id,
      }
    )
    emit(s, 'stickyOrphan', {
      flagKey,
      userId: uc.userId,
      assignment: sticky.assignment,
    })
    return
  }

  deliverExposure(s, {
    visitorId: uc.userId,
    experimentId: rule.id,
    variationId: sticky.vref.id,
    eventName: 'flag_exposure',
    revenue: null,
    timestamp: Date.now(),
    pageUrl: '',
    properties: { flagKey, flagId: flag.id },
  })
}
