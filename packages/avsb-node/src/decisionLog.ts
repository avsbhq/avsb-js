// =====================================================================
// Per-request decision log, and the redaction the type contract promises.
//
// `DecisionLogEntry` in @avsbhq/core says two things about privacy:
//   value:   "Redacted to '[REDACTED]' if any private attribute appeared in
//            the value."
//   reasons: "Reason strings have private attribute values replaced with
//            '[REDACTED]'."
//
// Neither was implemented. The old code compared the flag value against the
// private attribute NAMES (`privateAttrs.has(result.value)`), so a decision
// log only ever redacted the literal string "email" and happily wrote the
// actual email address that appeared in a reason string. A decision log is
// exactly the artifact people ship to a warehouse, so the promise has to be
// real.
//
// HOW IT WORKS NOW: we collect the VALUES of the attributes the caller marked
// private (`_meta.privateAttributes`), then redact anywhere they appear.
//
// The one judgement call, stated plainly: a private value of one character
// cannot be distinguished from ordinary text ("a" appears in almost every
// reason string), so single-character values are matched EXACTLY and not as
// substrings. Everything two characters and longer is matched as a substring,
// which deliberately over-redacts rather than leaking. Both behaviours are
// pinned by tests.
// =====================================================================

import type {
  DecisionLog,
  DecisionLogEntry,
  EvalContext,
  SingleContext,
} from '@avsbhq/core'
import { isMultiContext } from '@avsbhq/core'

export const REDACTED = '[REDACTED]'

/** Shortest private value we are willing to match as a substring. */
const MIN_SUBSTRING_LENGTH = 2

export function createDecisionLog(): DecisionLog {
  const entries: DecisionLogEntry[] = []
  return { entries }
}

/**
 * Comparable string forms of every attribute value the context marked
 * private. Longest first, so redacting a value never leaves a fragment of a
 * longer overlapping one behind.
 */
export function privateAttributeValues(ctx: EvalContext): string[] {
  const out = new Set<string>()

  const collect = (sub: SingleContext): void => {
    const names = sub._meta?.privateAttributes ?? []
    for (const name of names) {
      const raw = sub[name]
      if (raw === undefined || raw === null) continue
      const text = typeof raw === 'string' ? raw : stringify(raw)
      if (text) out.add(text)
    }
  }

  if (isMultiContext(ctx)) {
    for (const [kind, value] of Object.entries(ctx)) {
      if (kind === 'kind') continue
      if (!value || typeof value !== 'object') continue
      collect(value as SingleContext)
    }
  } else {
    collect(ctx)
  }

  return [...out].sort((a, b) => b.length - a.length)
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

function matches(haystack: string, needle: string): boolean {
  if (haystack === needle) return true
  if (needle.length < MIN_SUBSTRING_LENGTH) return false
  return haystack.includes(needle)
}

/**
 * The logged form of an evaluated value: `'[REDACTED]'` when any private
 * attribute value appears in it, otherwise the value unchanged.
 *
 * The whole value is replaced rather than patched, because a partially
 * redacted JSON payload is worse than useless: it looks complete.
 */
export function redactValue(value: unknown, privateValues: string[]): unknown {
  if (privateValues.length === 0) return value
  if (value === undefined || value === null) return value

  const serialised = stringify(value)
  if (!serialised) return value

  for (const priv of privateValues) {
    if (matches(serialised, priv)) return REDACTED
  }
  return value
}

/** Reason strings with every occurrence of a private value replaced. */
export function redactReasons(
  reasons: readonly string[],
  privateValues: string[]
): string[] {
  if (privateValues.length === 0) return [...reasons]

  return reasons.map((reason) => {
    let out = reason
    for (const priv of privateValues) {
      if (out === priv) return REDACTED
      if (priv.length < MIN_SUBSTRING_LENGTH) continue
      out = out.split(priv).join(REDACTED)
    }
    return out
  })
}

export interface DecisionLogAppendInput {
  flagKey: string
  value: unknown
  variationKey: string | null
  source: DecisionLogEntry['source']
  ruleId: string | null
  ruleType: DecisionLogEntry['ruleType']
  reasons: readonly string[]
  evaluatedAt: number
  durationMicros: number
  contextSummary: Array<{ kind: string; key: string }>
  privateValues: string[]
  manuallyFired?: boolean
}

/**
 * Append one redacted entry. Centralised so every writer (per-call option,
 * `UserBoundClient`, `manualExposure`) redacts identically; the previous
 * inline version was reachable from one path only.
 */
export function appendDecisionLogEntry(
  log: DecisionLog,
  input: DecisionLogAppendInput
): DecisionLogEntry {
  const entry: DecisionLogEntry = {
    flagKey: input.flagKey,
    value: redactValue(input.value, input.privateValues),
    variationKey: input.variationKey,
    source: input.source,
    ruleId: input.ruleId,
    ruleType: input.ruleType,
    reasons: redactReasons(input.reasons, input.privateValues),
    evaluatedAt: input.evaluatedAt,
    durationMicros: input.durationMicros,
    contextSummary: input.contextSummary,
    ...(input.manuallyFired ? { manuallyFired: true } : {}),
  }
  // `entries` is readonly to consumers on purpose; this module is the writer.
  ;(log.entries as DecisionLogEntry[]).push(entry)
  return entry
}
