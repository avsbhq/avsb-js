import type {
  Flag,
  EvaluationSource,
  LegacyEvaluationSource,
  RuleType,
} from './types'

/**
 * The six sources that count as "a real decision was made" for
 * `isEnabled()`. Locked identically in every SDK by the conformance
 * corpus' `semantics` fixture family (spec §1.4).
 */
const DECIDED_SOURCES: ReadonlySet<EvaluationSource> = new Set<EvaluationSource>(
  [
    'rule',
    'holdout',
    'bandit',
    'runtimeOverride',
    'datafileOverride',
    'sticky',
  ]
)

/** Sources that mean "no datafile answer for this key". */
const UNKNOWN_FLAG_SOURCES: ReadonlySet<EvaluationSource> =
  new Set<EvaluationSource>(['not_found', 'not_ready'])

interface FlagInit<T> {
  value: T
  variationKey: string | null
  source: EvaluationSource
  ruleId: string | null
  ruleType: RuleType | null
  reasons: string[]
  evaluatedAt?: number
  durationMicros?: number
}

/**
 * Construct a frozen `Flag<T>` value. The returned object is the
 * canonical evaluation result handed back from every public SDK
 * `getFlag*` call.
 *
 * `isEnabled()` is the convenience predicate "a real decision produced a
 * truthy value" that consumers use for `if (flag.isEnabled())` checks.
 * `exists()` mirrors LD's `flag.exists()` semantics: false when the flag
 * key is absent from the datafile, and also false when there is no
 * datafile yet (`not_ready`), because the question is unanswerable then.
 */
export function createFlag<T>(init: FlagInit<T>): Flag<T> {
  const flag: Flag<T> = Object.freeze({
    value: init.value,
    variationKey: init.variationKey,
    source: init.source,
    ruleId: init.ruleId,
    ruleType: init.ruleType,
    reasons: Object.freeze([...init.reasons]) as readonly string[] as string[],
    evaluatedAt: init.evaluatedAt ?? Date.now(),
    durationMicros: init.durationMicros ?? 0,
    isEnabled(): boolean {
      return DECIDED_SOURCES.has(this.source) && Boolean(this.value)
    },
    exists(): boolean {
      return !UNKNOWN_FLAG_SOURCES.has(this.source)
    },
  })
  return flag
}

/**
 * Sentinel `Flag<T>` returned when the datafile loaded and the flag key
 * is not in it. Frozen, stable, safe to compare by identity.
 *
 * Do NOT use this for "the SDK has not initialized yet" — that is
 * `notReadyFlag`, and conflating the two is the exact bug spec §1.2
 * closes.
 */
export function notFoundFlag<T>(defaultValue: T, reason: string): Flag<T> {
  return createFlag<T>({
    value: defaultValue,
    variationKey: null,
    source: 'not_found',
    ruleId: null,
    ruleType: null,
    reasons: [reason],
  })
}

/**
 * Sentinel `Flag<T>` returned when evaluation was attempted before a
 * datafile existed: init never completed, or it failed with no bootstrap
 * (spec §1.2). The value is the caller's default, `isEnabled()` is false,
 * and `exists()` is false because nothing is known about the key yet.
 */
export function notReadyFlag<T>(defaultValue: T, reason: string): Flag<T> {
  return createFlag<T>({
    value: defaultValue,
    variationKey: null,
    source: 'not_ready',
    ruleId: null,
    ruleType: null,
    reasons: [reason],
  })
}

/**
 * Map the legacy single-flag evaluator source enum onto the §2.12
 * public `EvaluationSource`. The two enums diverged when the public
 * surface added `datafileOverride` / `runtimeOverride` (replacing the
 * ambiguous `override`) and the held-out / bandit terminal sources.
 *
 * Public values pass through unchanged, so calling this on a value that
 * is already public is safe and idempotent. That matters because several
 * SDK layers cast into this function; before the passthrough existed, an
 * already-public input fell off the end of the switch and returned
 * `undefined`, silently producing a flag with no source.
 */
export function mapLegacySource(
  source: LegacyEvaluationSource | EvaluationSource
): EvaluationSource {
  switch (source) {
    case 'override':
      return 'datafileOverride'
    case 'runtime_override':
      return 'runtimeOverride'
    default:
      // Every remaining legacy member is spelled identically in the
      // public enum, so the value is already an EvaluationSource.
      return source
  }
}
