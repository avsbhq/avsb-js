// =====================================================================
// Server-evaluated flags, on their way to the browser.
//
// The wire shape itself is owned by @avsbhq/react (`SerializedFlag`),
// because that is where it is read: <AvsbProvider serverFlags={...}>
// revives it and every hook's `getServerSnapshot` answers from it. This
// module is the writer. The pair is round-tripped in ./index.test.tsx
// against the real reviver (imported from @avsbhq/react's source, not its
// build output), so the two halves cannot drift apart quietly.
//
// Why the values cannot just be `Flag` objects: `Flag` carries
// `isEnabled()` and `exists()`, and functions do not cross the server to
// client boundary. React rejects them in props and JSON drops them, so a
// server component that handed a `Flag` straight to a client component
// would either throw or deliver a half-object.
// =====================================================================

import type { EvalContext, Flag, FlagDatafile } from '@avsbhq/core'
import type { SerializedFlag, SerializedFlagMap } from '@avsbhq/react'
import { evaluateFlagServer } from './evaluateFlagServer'

/** Strip one `Flag` down to data. Mirrors `toSerializedFlag` in @avsbhq/react. */
export function serializeFlag(flag: Flag<unknown>): SerializedFlag {
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

/**
 * Evaluate every flag in the datafile for one context, as data.
 *
 * ```ts
 * function evaluateServerFlags(
 *   datafile: FlagDatafile,
 *   context: EvalContext,
 * ): SerializedFlagMap
 * ```
 *
 * No exposures are fired: `evaluateFlagServer` is a pure evaluator with no
 * tracker behind it. Pair the render with `useExposure(flagKey)` in the
 * client component that shows the variation, which is what makes a
 * server-rendered variant visible in results.
 */
export function evaluateServerFlags(
  datafile: FlagDatafile,
  context: EvalContext,
): SerializedFlagMap {
  const out: SerializedFlagMap = {}
  for (const entry of datafile.flags) {
    // `null` as the default: the value in the map is whatever the datafile
    // served, and null is the JSON-safe marker for "nothing was served".
    out[entry.key] = serializeFlag(evaluateFlagServer<null>(datafile, context, entry.key, null))
  }
  return out
}
