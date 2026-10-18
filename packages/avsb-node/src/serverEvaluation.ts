// Flag reads for AvsbServer: the single evaluation entry point, the typed
// check, forced decisions, decision logging and the bulk read. Split out of
// AvsbServer.ts (FU-31); the decision itself is in ./serverDecision.

import type { DecideOption, EvalContext, Flag } from '@avsbhq/core'
import {
  checkExpectedType,
  contextSummary,
  createFlag,
  findDatafileFlag,
  flagNotFoundMessage,
  notFoundFlag,
  notReadyFlag,
} from '@avsbhq/core'
import { appendDecisionLogEntry, privateAttributeValues } from './decisionLog'
import type { ResolvedDecideOptions } from './decideOptions'
import { emit, warnOnce } from './serverState'
import type { InternalGetFlagOptions, ServerState } from './serverState'
import { buildLegacyContext, evaluateDecision, findVariation } from './serverDecision'
import type { EvalResult, GetAllFlagsOptions } from './types'
import type { AvsbServer } from './AvsbServer'

/** The body of `AvsbServer.evaluateInternal`. */
export function evaluateServerFlag<T>(
  s: ServerState,
  server: AvsbServer,
  flagKey: string,
  defaultValue: NoInfer<T> | T,
  context?: EvalContext,
  options?: InternalGetFlagOptions
): Flag<T> {
  if (!context) {
    warnOnce(
      s,
      'no-context',
      `getFlag("${flagKey}") was called without a context, so it cannot be ` +
        'evaluated and returns the default you passed. Bind one per request with ' +
        'server.forUser({ kind: "user", key: userId }), or pass it as the third ' +
        'argument: server.getFlag(key, default, { kind: "user", key: userId }).'
    )
    return notReadyFlag(
      defaultValue as T,
      'no context passed; call server.forUser(context) or pass the context positionally'
    )
  }

  if (!server.isReady() || !s.datafile) {
    warnOnce(
      s,
      'not-ready',
      `getFlag("${flagKey}") was called before the datafile loaded, so it returns ` +
        'the default you passed and flag.source is "not_ready". Await ' +
        'server.onReady() during boot, or pass a bootstrap datafile to the ' +
        'constructor for an instant start.'
    )
    return notReadyFlag(defaultValue as T, 'SDK not ready: no datafile loaded yet')
  }

  const decide = s.resolveDecideOptions(options?.decideOptions)
  const flag = options?.forcedVariationKey
    ? buildForcedFlag<T>(
        s,
        flagKey,
        options.forcedVariationKey,
        defaultValue as T,
        context,
        options
      )
    : evaluateAndBuild<T>(
        s,
        flagKey,
        defaultValue as T,
        context,
        decide,
        options
      )

  return flag
}

function evaluateAndBuild<T>(
  s: ServerState,
  flagKey: string,
  defaultValue: T,
  context: EvalContext,
  decide: ResolvedDecideOptions,
  options?: InternalGetFlagOptions
): Flag<T> {
  const legacyCtx = buildLegacyContext(context, decide.suppressExposure)
  const result = evaluateDecision(s, flagKey, legacyCtx, defaultValue)
  if (result.source === 'not_found') {
    // Once per key: a missing key used to be silent here, so a key copied
    // from an old hyphenated example just served the default (N1-9).
    warnOnce(s, `missing:${flagKey}`, flagNotFoundMessage(flagKey))
  }
  const typeMismatch = checkType(s, flagKey, options?.expectedType, result)

  if (typeMismatch) {
    s.logger.warn(
      `Type mismatch on flag "${flagKey}": ${typeMismatch}; returning the default.`
    )
    const fallback = notFoundFlag(defaultValue, typeMismatch)
    recordDecision(s, flagKey, fallback, context, options)
    return fallback
  }

  const flag = toFlag<T>(result, defaultValue)
  recordDecision(s, flagKey, flag, context, options)
  return flag
}

function checkType(
  s: ServerState,
  flagKey: string,
  expectedType: InternalGetFlagOptions['expectedType'],
  result: EvalResult
): string | null {
  if (!expectedType) return null
  if (result.source === 'not_found' || result.source === 'disabled') return null
  const datafileFlag = findDatafileFlag(s.datafile, flagKey)
  return checkExpectedType(datafileFlag, expectedType, result.value) ?? null
}

function toFlag<T>(result: EvalResult, defaultValue: T): Flag<T> {
  return createFlag<T>({
    value: (result.value ?? defaultValue) as T,
    variationKey: result.variationKey,
    source: result.source,
    ruleId: result.ruleId,
    ruleType: result.ruleType,
    reasons: result.reasons,
    evaluatedAt: Date.now(),
    durationMicros: 0,
  })
}

/** Build a Flag from a forced variation key (per-request forced decision). */
function buildForcedFlag<T>(
  s: ServerState,
  flagKey: string,
  variationKey: string,
  defaultValue: T,
  context: EvalContext,
  options?: InternalGetFlagOptions
): Flag<T> {
  const vref = findVariation(s, flagKey, variationKey)
  const flag = createFlag<T>({
    value: (vref ? vref.value : defaultValue) as T,
    variationKey: vref ? vref.key : null,
    source: 'runtimeOverride',
    ruleId: null,
    ruleType: null,
    reasons: [`forced decision: variationKey="${variationKey}"`],
  })
  recordDecision(s, flagKey, flag, context, options)
  return flag
}

/** Emit the evaluation event and append to a decision log if one was passed. */
function recordDecision(
  s: ServerState,
  flagKey: string,
  flag: Flag,
  context: EvalContext,
  options?: InternalGetFlagOptions
): void {
  const summary = contextSummary(context)
  emit(s, 'evaluation', {
    flagKey,
    flag,
    contextKeys: summary.map((entry) => entry.key),
  })

  if (!options?.decisionLog) return
  appendDecisionLogEntry(options.decisionLog, {
    flagKey,
    value: flag.value,
    variationKey: flag.variationKey,
    source: flag.source,
    ruleId: flag.ruleId,
    ruleType: flag.ruleType,
    reasons: flag.reasons,
    evaluatedAt: flag.evaluatedAt,
    durationMicros: flag.durationMicros,
    contextSummary: summary,
    privateValues: privateAttributeValues(context),
  })
}

/**
 * The body of `AvsbServer.getAllFlags`. Each flag goes back through the
 * server's own `evaluateInternal`, as it always has.
 */
export function evaluateAllServerFlags(
  s: ServerState,
  server: AvsbServer,
  context?: EvalContext,
  options?: GetAllFlagsOptions
): Record<string, Flag> {
  if (!context) {
    warnOnce(
      s,
      'get-all-no-context',
      'getAllFlags() was called without a context and returned an empty object. ' +
        'Pass the context positionally, or use server.forUser(context).getAllFlags().'
    )
    return {}
  }
  if (!server.isReady() || !s.datafile) {
    warnOnce(
      s,
      'get-all-not-ready',
      'getAllFlags() was called before the datafile loaded and returned an empty ' +
        'object, which is indistinguishable from a project with no flags. Await ' +
        'server.onReady() first.'
    )
    return {}
  }

  const fireExposures = options?.fireExposures === true
  const decideOptions: DecideOption[] = [...(options?.decideOptions ?? [])]
  if (!fireExposures && !decideOptions.includes('DISABLE_EXPOSURE')) {
    decideOptions.push('DISABLE_EXPOSURE')
  }

  const out: Record<string, Flag> = {}
  for (const entry of s.datafile.flags) {
    out[entry.key] = server.evaluateInternal<unknown>(entry.key, undefined, context, {
      decideOptions,
      decisionLog: options?.decisionLog,
    })
  }
  return out
}
