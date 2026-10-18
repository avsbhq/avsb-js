// Flag reads for AvsbClient: the typed and untyped read paths, the one
// evaluation they share, and the bulk read. Split out of AvsbClient.ts
// (FU-31); the class keeps the public getters and calls these.

import type { GetFlagOptions, GetAllFlagsOptions } from './types'
import type { EvalContext, Flag, ExposureEvent, AvsbFlagKey } from '@avsbhq/core'
import {
  toLegacyEvalContext,
  createFlag,
  notFoundFlag,
  notReadyFlag,
  mapLegacySource,
  checkExpectedType,
  findDatafileFlag,
  flagNotFoundMessage,
  DecideOption,
} from '@avsbhq/core'
import { evaluateFlag } from '@avsbhq/core/engine'
import {
  NOT_READY_REASON,
  allFlagsNotReadyMessage,
  notReadyReadMessage,
  typedGetterMismatchMessage,
} from './messages'
import type { SnapshotVariant } from './snapshotCache'
import { warnOnce } from './clientState'
import type { ClientState } from './clientState'
import { emitEvaluation } from './clientEvents'
import { handleExposure } from './clientTracking'

/** Typed getters share one body: evaluate, then run the type check. */
export function readTyped<T>(
  s: ClientState,
  flagKey: AvsbFlagKey,
  defaultValue: T,
  variant: Exclude<SnapshotVariant, 'any'>,
  options?: GetFlagOptions,
): Flag<T> {
  const check = (flag: Flag<T>): Flag<T> => {
    // A pre-ready read is not a type mismatch. Without this the type check
    // would see "no datafile", report the flag as missing, and hand back
    // `not_found`, undoing B15 for every typed getter.
    if (flag.source === 'not_ready') return flag
    // Neither is a key the datafile does not carry (N1-15). It used to be
    // logged on EVERY read as "is not a boolean flag (flag declared as
    // boolean was not found)", which reads like a type problem. The miss
    // is reported once per key, in its own words, by computeFlag; a
    // runtime override set for an unknown key still answers not_found
    // from a typed getter, as before.
    if (s.datafile && !findDatafileFlag(s.datafile, flagKey)) {
      if (flag.source === 'not_found') return flag
      warnOnce(s, `missing:${flagKey}`, flagNotFoundMessage(flagKey))
      return notFoundFlag(defaultValue, `flag "${flagKey}" not found in datafile`)
    }
    // Readable with NO datafile means the value came from a server snapshot
    // adopted through `applySnapshot`. There is no declared type to compare
    // it with, and demanding one made every typed read of a server-evaluated
    // value answer "not found in the datafile" and return the caller's
    // default: the SSR handoff undone for `getBoolFlag` and its siblings,
    // while the untyped `getFlag` served the value correctly. The value's own
    // type is still checked, which is what the typed getter promises.
    const typeError = s.datafile
      ? checkExpectedType(findDatafileFlag(s.datafile, flagKey), variant, flag.value)
      : snapshotValueTypeError(flagKey, variant, flag.value)
    if (!typeError) return flag
    // Once per key and getter: a render loop must not flood the console.
    warnOnce(
      s,
      `typed:${flagKey}:${variant}`,
      typedGetterMismatchMessage(flagKey, variant, typeError),
    )
    return notFoundFlag(defaultValue, typeError)
  }

  if (options?.readOnly === true) {
    // Cached under the typed variant so the type-checked answer is the
    // stable one the adapter re-reads on every render.
    return s.snapshots.get<T>(flagKey, variant, defaultValue, () =>
      check(computeFlag<T>(s, flagKey, defaultValue, false)),
    )
  }
  return check(readFlag<T>(s, flagKey, defaultValue, variant, options))
}

/**
 * The one read path. Decides exposure and caching, then delegates the
 * actual evaluation to `computeFlag`.
 */
export function readFlag<T>(
  s: ClientState,
  flagKey: AvsbFlagKey,
  defaultValue: T,
  variant: SnapshotVariant,
  options?: GetFlagOptions,
): Flag<T> {
  if (options?.readOnly === true) {
    return s.snapshots.get<T>(flagKey, variant, defaultValue, () =>
      computeFlag<T>(s, flagKey, defaultValue, false),
    )
  }

  const disabledByDecideOption =
    options?.decideOptions?.includes(DecideOption.DISABLE_EXPOSURE) === true
  const fireExposure = options?.fireExposure !== false && !disabledByDecideOption

  const flag = computeFlag<T>(s, flagKey, defaultValue, fireExposure)
  if (flag.source !== 'not_ready') emitEvaluation(s, flagKey, flag)
  return flag
}

/**
 * Evaluate one flag. Consults runtime overrides first (§5.9), then the
 * evaluator. Never touches the snapshot cache or the event bus, so both
 * cached and live reads share one definition of the answer.
 */
function computeFlag<T>(
  s: ClientState,
  flagKey: string,
  defaultValue: T,
  fireExposure: boolean,
): Flag<T> {
  if (!s.datafile) {
    // A server bootstrap snapshot answers reads until a datafile is loaded.
    // No exposure either way: the server already decided whether to record
    // one for this decision.
    const fromSnapshot = s.snapshotBootstrap.read<T>(flagKey, defaultValue)
    if (fromSnapshot) return fromSnapshot
    if (s.snapshotBootstrap.isActive()) {
      // N1-16: the server evaluated EVERY flag in its datafile, so a key
      // the snapshot does not carry is not in that datafile: `not_found`,
      // exactly what the first local evaluation will say, not `not_ready`.
      warnOnce(s, `missing:${flagKey}`, flagNotFoundMessage(flagKey, 'snapshot'))
      return notFoundFlag(defaultValue, `flag "${flagKey}" not found in the server bootstrap snapshot`)
    }
  }

  if (!s.ready || !s.datafile) {
    // B15: `not_ready`, not `not_found`. "You asked too early" and "that
    // flag does not exist" are different problems with different fixes.
    warnOnce(s, `not-ready:${flagKey}`, notReadyReadMessage(flagKey))
    return notReadyFlag(defaultValue, NOT_READY_REASON)
  }

  const override = s.overrides.resolve<T>(flagKey, s.context, s.datafile)
  if (override) return override

  const onExposure =
    fireExposure && s.tracker
      ? (event: ExposureEvent) => handleExposure(s, event, s.context)
      : undefined

  // Reasons are collected on every browser evaluation (report 02 §5.8):
  // the evaluator only fills a caller-supplied array, so without this
  // `flag.reasons` was permanently empty here while node's was real.
  const reasons: string[] = []
  const t0 = performance.now()
  const evaluation = evaluateFlag(
    flagKey,
    defaultValue,
    toLegacyEvalContext(s.context),
    s.datafile,
    onExposure,
    reasons,
  )
  const durationMicros = Math.round((performance.now() - t0) * 1000)

  // N1-15: a missing key is reported once per key, as a missing key, on
  // every read path (typed, untyped, render-safe), never once per read.
  if (evaluation.source === 'not_found') {
    warnOnce(s, `missing:${flagKey}`, flagNotFoundMessage(flagKey))
  }

  return createFlag<T>({
    value: evaluation.value as T,
    variationKey: evaluation.variationKey,
    source: mapLegacySource(evaluation.source),
    ruleId: evaluation.ruleId,
    ruleType: evaluation.ruleType,
    reasons: evaluation.reasons,
    durationMicros,
  })
}

/** Evaluate every flag in the datafile against one context. */
function evaluateAll(
  s: ClientState,
  ctx: EvalContext,
  onExposure?: (event: ExposureEvent) => void,
): Record<string, Flag> {
  if (!s.datafile) return {}
  const legacyCtx = toLegacyEvalContext(ctx)
  const result: Record<string, Flag> = {}

  for (const entry of s.datafile.flags) {
    const override = s.overrides.resolve(entry.key, ctx, s.datafile)
    if (override) {
      result[entry.key] = override
      continue
    }
    const reasons: string[] = []
    const evaluation = evaluateFlag(
      entry.key,
      undefined,
      legacyCtx,
      s.datafile,
      onExposure,
      reasons,
    )
    result[entry.key] = createFlag({
      value: evaluation.value,
      variationKey: evaluation.variationKey,
      source: mapLegacySource(evaluation.source),
      ruleId: evaluation.ruleId,
      ruleType: evaluation.ruleType,
      reasons: evaluation.reasons,
    })
  }
  return result
}

/** The body of `AvsbClient.getAllFlags`. */
export function readAllFlags(
  s: ClientState,
  options?: GetAllFlagsOptions,
): Record<string, Flag> {
  if (!s.datafile && s.snapshotBootstrap.isActive()) {
    // A server bootstrap snapshot IS the full flag set for this context, so
    // the SSR-rendered page can list flags before its datafile arrives.
    return s.snapshotBootstrap.readAll()
  }
  if (!s.ready || !s.datafile) {
    // Never silent (report 02 §5.33): an empty map is indistinguishable
    // from "this project has no flags".
    warnOnce(s, 'all-flags-not-ready', allFlagsNotReadyMessage())
    return {}
  }

  const fireExposures = options?.fireExposures === true
  const requestedContext = options?.context

  // The plain read is cached so repeated calls (a `useAllFlags` hook runs
  // one per render) return the same object until something changes.
  if (!fireExposures && !requestedContext && s.allFlagsSnapshot) {
    return s.allFlagsSnapshot
  }

  // The context actually evaluated, which is what the exposures belong to
  // and what their private attributes are declared on.
  const evaluatedContext = requestedContext ?? s.context
  const onExposure = fireExposures
    ? (event: ExposureEvent) => handleExposure(s, event, evaluatedContext)
    : undefined

  const result = evaluateAll(s, evaluatedContext, onExposure)

  if (!fireExposures && !requestedContext) s.allFlagsSnapshot = result
  return result
}

/**
 * Type check for a value that has no datafile behind it: a server-evaluated
 * snapshot adopted through `applySnapshot`. Mirrors `checkExpectedType`'s
 * value rules and its message wording, minus the declared-type comparison
 * there is nothing to make.
 */
function snapshotValueTypeError(
  flagKey: string,
  variant: 'boolean' | 'string' | 'number' | 'json',
  value: unknown,
): string | null {
  if (variant === 'json') {
    return value === undefined
      ? `flag "${flagKey}" resolved to undefined which is not valid JSON`
      : null
  }
  if (variant === 'number') {
    return typeof value === 'number' && !Number.isNaN(value)
      ? null
      : `flag "${flagKey}" resolved to a non-number value (typeof === "${typeof value}")`
  }
  return typeof value === variant
    ? null
    : `flag "${flagKey}" resolved to a non-${variant} value (typeof === "${typeof value}")`
}
