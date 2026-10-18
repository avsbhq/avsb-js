/**
 * Failures that happen inside the CLI, before or without a request.
 *
 * Kept apart from `ApiRequestError` on purpose: "you are not in a project
 * directory" and "the platform refused this" are different problems, they
 * deserve different exit codes, and a script reading `--json` can tell them
 * apart by the `cli_` prefix on the code without parsing English.
 */

import { EXIT, type ExitCode } from './exitCodes.js'
import type { CliErrorCode } from '../types/output.js'

const EXIT_FOR_CODE: Record<CliErrorCode, ExitCode> = {
  cli_usage: EXIT.usage,
  cli_not_logged_in: EXIT.auth,
  cli_credential_shape: EXIT.auth,
  cli_no_project: EXIT.usage,
  cli_no_manifest: EXIT.usage,
  cli_not_found: EXIT.failure,
  cli_conflict: EXIT.conflict,
  cli_io_failed: EXIT.failure,
  cli_failed: EXIT.failure,
  cli_network: EXIT.failure,
}

export class CliError extends Error {
  readonly code: CliErrorCode
  /** Extra lines printed under the message: what to do next. */
  readonly hints: string[]

  constructor(code: CliErrorCode, message: string, hints: string[] = []) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.hints = hints
  }

  get exitCode(): ExitCode {
    return EXIT_FOR_CODE[this.code]
  }
}
