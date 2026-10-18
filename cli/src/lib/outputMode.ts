/**
 * Where output goes, and how loud it is.
 *
 * Two rules the whole CLI obeys, and this module is the only place that knows
 * how to obey them:
 *
 *   1. Results go to stdout, everything about the run (progress, warnings,
 *      errors) goes to stderr. `avsb metrics list --json > metrics.json` must
 *      leave a valid JSON file even when the run also printed a warning.
 *   2. With `--json` or `--quiet`, human decoration is not printed at all. In
 *      JSON mode stdout carries exactly one document and nothing else.
 *
 * The mode is process-wide because it is a property of the run, not of a
 * function call. `beginCommand` in `output.ts` sets it once per command.
 */

import ora from 'ora'

export interface OutputMode {
  json: boolean
  quiet: boolean
}

const DEFAULT_MODE: OutputMode = { json: false, quiet: false }

let mode: OutputMode = { ...DEFAULT_MODE }

/** True when the value reads as "on" in an environment variable. */
export function envFlagEnabled(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false
  const value = raw.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * Combine what the user typed with what the environment says.
 *
 * `--json` implies quiet: a JSON document with a progress spinner interleaved
 * is not a JSON document. Pure so both halves are testable without a process.
 */
export function resolveOutputMode(
  opts: { json?: boolean; quiet?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): OutputMode {
  const json = opts.json === true || envFlagEnabled(env.AVSB_JSON)
  const quiet = json || opts.quiet === true || envFlagEnabled(env.AVSB_QUIET)
  return { json, quiet }
}

export function setOutputMode(next: OutputMode): void {
  mode = next
}

/** Back to the defaults. Exists for tests; nothing in a real run calls it. */
export function resetOutputMode(): void {
  mode = { ...DEFAULT_MODE }
}

export function isJsonOutput(): boolean {
  return mode.json
}

export function isQuiet(): boolean {
  return mode.quiet
}

/** Results only. Never called while `isQuiet()` unless the caller IS the result. */
export function writeOut(line: string): void {
  process.stdout.write(`${line}\n`)
}

/** Everything a human needs to know about the run. */
export function writeErr(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** The bits of `ora` the CLI uses, so a silent run can supply its own. */
export interface CliSpinner {
  succeed(text?: string): void
  fail(text?: string): void
  warn(text?: string): void
  stop(): void
}

const SILENT_SPINNER: CliSpinner = {
  succeed: () => undefined,
  fail: () => undefined,
  warn: () => undefined,
  stop: () => undefined,
}

/**
 * A started spinner, or a silent stand-in in quiet and JSON modes.
 *
 * `ora` already writes to stderr, so a spinner never corrupts piped output; it
 * is suppressed anyway because progress animation in a log file helps nobody.
 */
export function startSpinner(text: string): CliSpinner {
  if (mode.quiet) return SILENT_SPINNER
  return ora(text).start()
}
