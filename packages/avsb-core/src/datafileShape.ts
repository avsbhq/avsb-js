// =====================================================================
// Is this value shaped like a datafile the evaluator can read? (N0-15)
//
// The evaluator dereferences a handful of arrays unconditionally:
// `flags`, `audiences`, and on every flag `variations`, `overrides` and
// `rules`, and on every rule `audienceIds` and `variations`. A datafile
// that breaks one of them (a hand-built bootstrap such as `{ flags: {} }`,
// a truncated cache entry, a proxy that rewrote the JSON) used to throw a
// TypeError from inside a flag read, although reads are documented never
// to throw.
//
// The SDK clients call this when they ADOPT a datafile (bootstrap option,
// `applyDatafileBootstrap`, a fetched or cached copy) and refuse a
// malformed one with a warning that names the broken field, so reads
// answer `not_ready` the normal way instead of crashing. One pass per
// adopted datafile, never per read.
//
// Deliberately structural and shallow: it checks the fields the evaluator
// would throw on, not every documented field. Unknown extra fields are
// fine, because datafiles gain fields over time.
// =====================================================================

/** "an object", "an array", "a string", "null", "missing": for messages. */
function describe(value: unknown): string {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  const kind = typeof value
  return kind === 'object' ? 'an object' : `a ${kind}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectArray(value: unknown, path: string): string | null {
  return Array.isArray(value) ? null : `${path} is ${describe(value)}, expected an array`
}

function ruleProblem(rule: unknown, path: string): string | null {
  if (!isRecord(rule)) return `${path} is ${describe(rule)}, expected an object`
  return (
    expectArray(rule['audienceIds'], `${path}.audienceIds`) ??
    expectArray(rule['variations'], `${path}.variations`)
  )
}

function flagProblem(flag: unknown, path: string): string | null {
  if (!isRecord(flag)) return `${path} is ${describe(flag)}, expected an object`
  if (typeof flag['key'] !== 'string') {
    return `${path}.key is ${describe(flag['key'])}, expected a string`
  }
  const arrays =
    expectArray(flag['variations'], `${path}.variations`) ??
    expectArray(flag['overrides'], `${path}.overrides`) ??
    expectArray(flag['rules'], `${path}.rules`)
  if (arrays) return arrays
  const rules = flag['rules'] as unknown[]
  for (let i = 0; i < rules.length; i++) {
    const problem = ruleProblem(rules[i], `${path}.rules[${i}]`)
    if (problem) return problem
  }
  return null
}

/**
 * The first reason `value` cannot be used as a flag datafile, in words that
 * name the broken field, or `null` when the evaluator can read it.
 *
 * ```ts
 * datafileShapeProblem({ flags: {}, audiences: [] })
 * // 'datafile.flags is an object, expected an array'
 * ```
 */
export function datafileShapeProblem(value: unknown): string | null {
  if (!isRecord(value)) return `the datafile is ${describe(value)}, expected an object`

  const topLevel =
    expectArray(value['flags'], 'datafile.flags') ??
    expectArray(value['audiences'], 'datafile.audiences')
  if (topLevel) return topLevel

  // Optional lists: absent is fine, present-but-wrong is not.
  for (const optional of ['holdouts', 'bandits'] as const) {
    const listed = value[optional]
    if (listed !== undefined && listed !== null && !Array.isArray(listed)) {
      return `datafile.${optional} is ${describe(listed)}, expected an array when present`
    }
  }

  const flags = value['flags'] as unknown[]
  for (let i = 0; i < flags.length; i++) {
    const problem = flagProblem(flags[i], `datafile.flags[${i}]`)
    if (problem) return problem
  }
  return null
}
