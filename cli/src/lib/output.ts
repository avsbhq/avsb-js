/**
 * The machine-readable half of the CLI's output: one envelope, one exit code,
 * one place that decides both.
 *
 * A command's shape is always the same:
 *
 *   beginCommand('flags list', opts)      // reads --json / --quiet
 *   …
 *   if (emitJsonResult(payload)) return   // JSON mode printed it; stop here
 *   …human rendering…
 *
 * and any failure goes through `failCommand`, so the JSON envelope, the human
 * message on stderr, and the exit code can never disagree with each other.
 *
 * The envelope itself is documented in `types/output.ts` and in
 * content/docs/developer-reference/cli-tool.mdx.
 */

import type { Command } from 'commander'
import { ApiRequestError, describeApiFailure } from './apiError.js'
import type { PathLabeller } from './apiErrorDetails.js'
import { CliError } from './cliError.js'
import { EXIT, type ExitCode } from './exitCodes.js'
import * as logger from './logger.js'
import {
  isJsonOutput,
  resolveOutputMode,
  setOutputMode,
  writeOut,
} from './outputMode.js'
import type { JsonErrorBody, JsonResultMeta } from '../types/output.js'

/** Code used when the platform refused but the route sends no machine code. */
export const UNCLASSIFIED_API_ERROR_CODE = 'api_error'

let commandName = ''

export interface OutputOptions {
  json?: boolean
  quiet?: boolean
}

/**
 * Add `--json` and `--quiet` to a command. Only read commands get them: a
 * command that cannot print a stable document should reject the flag rather
 * than accept it and print prose.
 */
export function withOutputOptions(cmd: Command): Command {
  return cmd
    .option('--json', 'Print the result as one JSON document on stdout')
    .option('--quiet', 'Print only the result; progress and notes are suppressed')
}

/**
 * Start a command: record its name for the envelope and apply the output mode.
 * Called first in every action, before anything that can fail, so even a
 * credential failure comes back as JSON when JSON was asked for.
 */
export function beginCommand(name: string, opts: OutputOptions = {}): void {
  commandName = name
  setOutputMode(resolveOutputMode(opts))
}

export function currentCommandName(): string {
  return commandName
}

/** Forget the current command. Exists for tests. */
export function resetCommandName(): void {
  commandName = ''
}

/**
 * Print the success envelope when `--json` is on.
 *
 * Returns true when it printed, so the caller can `return` instead of also
 * rendering the human view. `meta` carries facts about the response (the ETag,
 * a page cursor) so `data` stays exactly what the platform returned.
 */
export function emitJsonResult(data: unknown, meta?: JsonResultMeta): boolean {
  if (!isJsonOutput()) return false
  const envelope: { ok: true; command: string; data: unknown; meta?: JsonResultMeta } = {
    ok: true,
    command: commandName,
    data,
  }
  if (meta && Object.keys(meta).length > 0) envelope.meta = meta
  writeOut(JSON.stringify(envelope, null, 2))
  return true
}

/** The error body for the JSON envelope. Pure, so every branch is testable. */
export function toJsonErrorBody(error: unknown): JsonErrorBody {
  if (error instanceof ApiRequestError) {
    return {
      code: error.code ?? UNCLASSIFIED_API_ERROR_CODE,
      message: error.message,
      status: error.status,
      ...(error.docUrl ? { docUrl: error.docUrl } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
      ...(error.details ? { details: error.details } : {}),
    }
  }

  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.hints.length > 0 ? { details: { hints: error.hints } } : {}),
    }
  }

  return {
    code: 'cli_failed',
    message: error instanceof Error ? error.message : 'Command failed',
  }
}

/** The exit code a failure deserves. */
export function exitCodeFor(error: unknown): ExitCode {
  if (error instanceof ApiRequestError) return error.exitCode
  if (error instanceof CliError) return error.exitCode
  return EXIT.failure
}

/** The follow-on lines printed under the message, for humans. */
export function hintsFor(error: unknown, labelForPath?: PathLabeller): string[] {
  if (error instanceof ApiRequestError) return describeApiFailure(error, labelForPath)
  if (error instanceof CliError) return error.hints
  return []
}

export interface FailOptions {
  /**
   * Names the local file a request-body path refers to, so a validation or
   * compile failure says `control/control.js` instead of `variations.0.controlJs`.
   */
  labelForPath?: PathLabeller
}

/**
 * Report a failure and stop.
 *
 * JSON mode prints the error envelope on stdout (a script parses one shape
 * whether the run worked or not) AND the message on stderr, because a human
 * watching a CI log should not have to pipe it through a parser. The reasons in
 * `details` (field issues, compile errors) print in human mode too.
 */
export function failCommand(error: unknown, options: FailOptions = {}): never {
  const body = toJsonErrorBody(error)

  if (isJsonOutput()) {
    writeOut(JSON.stringify({ ok: false, command: commandName, error: body }, null, 2))
  }

  logger.error(body.message)
  for (const hint of hintsFor(error, options.labelForPath)) logger.errorDetail(hint)

  process.exit(exitCodeFor(error))
}
