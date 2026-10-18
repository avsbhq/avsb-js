/**
 * Writing one variable into the developer's environment file, without ever
 * losing what was already there.
 *
 * Three rules, because this file belongs to someone else:
 *
 *   1. APPEND ONLY. An existing assignment is never rewritten. If the variable
 *      is already set to something else, nothing is written and the caller is
 *      told, so a second `avsb init` cannot silently repoint an app at a
 *      different environment.
 *   2. IDEMPOTENT. Running twice with the same value leaves the file
 *      byte-identical, so init is safe to re-run after a failure.
 *   3. BANNERED. The appended block carries a comment saying what wrote it, so
 *      the line is not a mystery in six months.
 *
 * Deliberately hand-rolled rather than a dotenv dependency: this reads one
 * variable name and appends one line, and the CLI's dependency list is worth
 * more than the twenty lines below.
 *
 * The parsing and composition are pure. `writeEnvAssignment` is the only part
 * that touches disk.
 */

import fs from 'node:fs'
import path from 'node:path'

export const ENV_BANNER = '# A vs B feature flags. Added by `avsb init`.'

export type EnvWriteOutcome =
  /** The file did not exist and now holds the banner plus one line. */
  | 'created'
  /** The line was appended under the banner. */
  | 'appended'
  /** The variable was already set to this exact value. Nothing changed. */
  | 'unchanged'
  /** The variable is set to something else. Nothing was written. */
  | 'conflict'

export interface EnvApplyResult {
  outcome: EnvWriteOutcome
  /** What the file should contain. Equal to the input on `unchanged`/`conflict`. */
  content: string
  /** The value already on the line, when the outcome is `conflict`. */
  existingValue: string | null
}

/**
 * The value already assigned to `name`, or null.
 *
 * Understands the two forms dotenv-style files use in the wild (`NAME=value`
 * and `export NAME=value`), strips one layer of matching quotes, and ignores
 * commented-out lines. It does not try to be a full parser: a variable this
 * cannot read is reported as absent, and the worst case is an appended
 * duplicate that the reader can see.
 */
export function readEnvAssignment(content: string, name: string): string | null {
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${escapeForRegExp(name)}\\s*=(.*)$`)

  for (const line of content.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue
    const match = pattern.exec(line)
    if (!match) continue
    return unquote(match[1].trim())
  }

  return null
}

/**
 * What the file should look like after setting `name` to `value`.
 *
 * Never throws and never rewrites: see the module docblock for why a conflict
 * is reported rather than resolved.
 */
export function applyEnvAssignment(
  existing: string | null,
  name: string,
  value: string,
): EnvApplyResult {
  const assignment = `${name}=${formatEnvValue(value)}`

  if (existing === null) {
    return {
      outcome: 'created',
      content: `${ENV_BANNER}\n${assignment}\n`,
      existingValue: null,
    }
  }

  const current = readEnvAssignment(existing, name)
  if (current !== null) {
    return current === value
      ? { outcome: 'unchanged', content: existing, existingValue: current }
      : { outcome: 'conflict', content: existing, existingValue: current }
  }

  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
  return {
    outcome: 'appended',
    content: `${existing}${separator}${ENV_BANNER}\n${assignment}\n`,
    existingValue: null,
  }
}

/**
 * Quote only when the value would not survive unquoted. SDK keys never need it;
 * the check is here so a future value with a space or a `#` cannot corrupt the
 * file.
 */
export function formatEnvValue(value: string): string {
  return /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : `"${value.replace(/(["\\])/g, '\\$1')}"`
}

export interface EnvWriteRequest {
  /** Project root the file is relative to. */
  dir: string
  /** File name, e.g. `.env.local`. */
  file: string
  name: string
  value: string
}

export interface EnvWriteResult extends EnvApplyResult {
  /** Absolute path, so the CLI can echo exactly what it touched. */
  filePath: string
  /** True when bytes were written. */
  wrote: boolean
}

/** Apply the rules above to a real file. The only IO in this module. */
export function writeEnvAssignment(request: EnvWriteRequest): EnvWriteResult {
  const filePath = path.resolve(request.dir, request.file)

  let existing: string | null = null
  try {
    existing = fs.readFileSync(filePath, 'utf-8')
  } catch {
    existing = null
  }

  const applied = applyEnvAssignment(existing, request.name, request.value)
  const wrote = applied.outcome === 'created' || applied.outcome === 'appended'

  if (wrote) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, applied.content, 'utf-8')
  }

  return { ...applied, filePath, wrote }
}

/** The line the CLI prints about what it did, so nothing is implied. */
export function describeEnvWrite(result: EnvWriteResult, name: string): string {
  switch (result.outcome) {
    case 'created':
      return `Created ${result.filePath} with ${name}`
    case 'appended':
      return `Added ${name} to ${result.filePath}`
    case 'unchanged':
      return `${name} in ${result.filePath} already holds this key. Left alone.`
    case 'conflict':
      return `${name} in ${result.filePath} holds a different key. Left alone: change it yourself if you meant to switch environments.`
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Strip one layer of matching quotes, undoing the escaping `formatEnvValue`
 * applies.
 *
 * The unescaping is what keeps a re-run idempotent for a value that needed
 * quoting: without it, the CLI writes `"a\"b"`, then reads back the raw `a\"b`,
 * compares it against the real `a"b`, and reports a conflict against its own
 * line. Only double-quoted values are unescaped, because those are the only
 * ones this module writes; single-quoted values are literal by convention.
 */
function unquote(value: string): string {
  const quoted = /^(["'])([\s\S]*)\1$/.exec(value)
  if (!quoted) return value
  const [, quote, body] = quoted
  return quote === '"' ? body.replace(/\\(["\\])/g, '$1') : body
}
