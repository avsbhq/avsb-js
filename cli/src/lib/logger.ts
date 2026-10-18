/**
 * Human-readable output.
 *
 * Stream discipline (report 06 §5, WS6 item 7): results and progress notes go to
 * stdout, warnings and errors go to STDERR. Before this split every line went to
 * stdout via `console.log`, so `avsb metrics list > out.txt` swallowed the error
 * that explained why the file was empty.
 *
 * Everything here is suppressed by `--quiet` and by `--json` except three
 * things: `warn` and `error` (a quiet run is still allowed to say why it
 * failed, and stderr is the right place for it in every mode), and `line`,
 * which carries the result itself.
 */

import chalk from 'chalk'
import { isJsonOutput, isQuiet, writeErr, writeOut } from './outputMode.js'

export function info(msg: string): void {
  if (isQuiet()) return
  writeOut(`${chalk.blue('i')} ${msg}`)
}

export function success(msg: string): void {
  if (isQuiet()) return
  writeOut(`${chalk.green('✓')} ${msg}`)
}

/** Stderr, always: a warning nobody sees is not a warning. */
export function warn(msg: string): void {
  writeErr(`${chalk.yellow('!')} ${msg}`)
}

/** Stderr, always. */
export function error(msg: string): void {
  writeErr(`${chalk.red('✗')} ${msg}`)
}

/** Stderr, always. Indented follow-on lines under a warning or an error. */
export function errorDetail(msg: string): void {
  writeErr(chalk.dim(`  ${msg}`))
}

export function dim(msg: string): void {
  if (isQuiet()) return
  writeOut(chalk.dim(msg))
}

export function heading(msg: string): void {
  if (isQuiet()) return
  writeOut(chalk.bold.white(msg))
}

export function label(key: string, value: string): void {
  if (isQuiet()) return
  writeOut(`  ${chalk.dim(key + ':')} ${value}`)
}

/**
 * One labelled line of RESULT output: `Email: jane@example.com`.
 *
 * Unlike `label`, which decorates a summary, this is the answer itself, so
 * `--quiet` keeps it (without the indent and colour) and only `--json` drops
 * it. `avsb whoami --quiet` printed nothing at all when its rows were labels
 * (QA N4-14).
 */
export function field(key: string, value: string): void {
  if (isJsonOutput()) return
  if (isQuiet()) {
    writeOut(`${key}: ${value}`)
    return
  }
  writeOut(`  ${chalk.dim(key + ':')} ${value}`)
}

export function fileTree(lines: string[]): void {
  if (isQuiet()) return
  for (const line of lines) {
    writeOut(chalk.dim('  ' + line))
  }
}

/**
 * One line of RESULT output: a table row, a completion script, a URL.
 *
 * This is the one thing `--quiet` must not swallow. "Print only the result"
 * means the result still prints, so `eval "$(avsb completion bash)"` keeps
 * working with `AVSB_QUIET=1` set. Blank spacers are decoration rather than
 * result, so they are the only thing quiet mode drops here. JSON mode suppresses
 * all of it: there, the envelope IS the result.
 */
export function line(msg = ''): void {
  if (isJsonOutput()) return
  if (isQuiet() && msg.length === 0) return
  writeOut(msg)
}
