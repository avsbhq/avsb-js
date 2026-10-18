// =====================================================================
// Server-evaluated flag values, on the wire and back (report 03 §5 Next,
// §7 item 3).
//
// THE BUG THIS EXISTS TO KILL: every hook's `getServerSnapshot` returned
// a default-valued sentinel, so server-rendered HTML always showed
// defaults no matter how much the server had already evaluated. The
// "no hydration flicker" claim was false by construction, and the
// pre-evaluated flags a Next server component produced were consumed by
// nothing in the repo.
//
// The fix is a channel React can use on BOTH sides of hydration: the
// server evaluates, serialises to this shape, hands it to
// `<AvsbProvider serverFlags={...}>` as a normal prop, and every hook's
// `getServerSnapshot` answers from it. Because it arrives as a prop, the
// server render and the hydration render see the same values, which is
// the only way `useSyncExternalStore` can avoid a mismatch. Reading the
// same values out of the DOM on the client instead would produce HTML
// that says one thing and a hydration pass that says another.
//
// Why a separate shape from `Flag<T>`: `Flag<T>` carries `isEnabled()`
// and `exists()`. Functions cannot cross the server/client boundary (React
// rejects them in props, and JSON drops them), so the wire form is data
// only and `reviveServerFlags` rebuilds real `Flag` objects with their
// methods on the client.
// =====================================================================

import type { AvsbFlagKey, EvaluationSource, Flag, RuleType } from '@avsbhq/core'
import { createFlag } from '@avsbhq/core'

/**
 * One server-evaluated flag, as data. Field-for-field a `Flag<unknown>`
 * minus its two methods.
 */
export interface SerializedFlag {
  /** The variation value the server evaluated. */
  value: unknown
  /** Variation key, or null when the default was served. */
  variationKey: string | null
  /** Why this value was produced. Same union as `Flag.source`. */
  source: EvaluationSource
  /** Rule that matched, or null. */
  ruleId: string | null
  /** Rule type that matched, or null. */
  ruleType: RuleType | null
  /** Structured reasons for the decision. */
  reasons: string[]
  /** ms-epoch of the server evaluation. */
  evaluatedAt: number
}

/** Server-evaluated flags keyed by flag key. */
export type SerializedFlagMap = Record<string, SerializedFlag>

/** Strip a `Flag<T>` down to the wire shape. */
export function toSerializedFlag(flag: Flag<unknown>): SerializedFlag {
  return {
    value: flag.value,
    variationKey: flag.variationKey,
    source: flag.source,
    ruleId: flag.ruleId,
    ruleType: flag.ruleType,
    reasons: [...flag.reasons],
    evaluatedAt: flag.evaluatedAt,
  }
}

/** Strip a whole map. */
export function toSerializedFlagMap(
  flags: Record<string, Flag<unknown>>,
): SerializedFlagMap {
  const out: SerializedFlagMap = {}
  for (const [key, flag] of Object.entries(flags)) {
    out[key] = toSerializedFlag(flag)
  }
  return out
}

/**
 * Rebuild real `Flag` objects (methods included) from the wire shape.
 *
 * Called once per provider mount and memoised, so the objects handed to
 * `getServerSnapshot` are referentially stable for the life of the mount.
 * That stability is a requirement, not an optimisation: React compares
 * store snapshots by identity.
 *
 * Unknown or malformed entries are skipped rather than trusted: a blob
 * can come off the wire, and a half-built `Flag` would break `.reasons`
 * or `isEnabled()` deep inside a component instead of here.
 */
export function reviveServerFlags(
  serialized: SerializedFlagMap | null | undefined,
): Record<string, Flag> {
  if (!serialized) return {}
  const out: Record<string, Flag> = {}
  for (const [key, entry] of Object.entries(serialized)) {
    if (!isSerializedFlag(entry)) continue
    out[key] = createFlag<unknown>({
      value: entry.value,
      variationKey: entry.variationKey,
      source: entry.source,
      ruleId: entry.ruleId,
      ruleType: entry.ruleType,
      reasons: entry.reasons,
      evaluatedAt: entry.evaluatedAt,
    })
  }
  return out
}

/**
 * Read one revived server flag, typed against the default the caller
 * passed. Returns null when the server did not evaluate that key, which
 * is the signal for a hook to fall back to its sentinel.
 *
 * The value is NOT type-checked against `T`: the server already ran the
 * same evaluator, and a mismatch means the flag's platform type changed
 * between the two, which the client's typed getter reports on the first
 * live read.
 */
export function readServerFlag<T>(
  serverFlags: Record<string, Flag> | null | undefined,
  flagKey: AvsbFlagKey,
): Flag<T> | null {
  const flag = serverFlags?.[flagKey]
  // The cast narrows `Flag<unknown>` to the caller's `T`. Sound because the
  // server evaluated the same flag from the same datafile with the same
  // evaluator: the value it produced is the value a live read produces.
  return flag ? (flag as Flag<T>) : null
}

function isSerializedFlag(value: unknown): value is SerializedFlag {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<SerializedFlag>
  return (
    typeof candidate.source === 'string' &&
    Array.isArray(candidate.reasons) &&
    (candidate.variationKey === null || typeof candidate.variationKey === 'string')
  )
}
