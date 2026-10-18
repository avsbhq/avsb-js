/**
 * What the CLI's exit codes mean.
 *
 * A script needs to tell "log in again" apart from "the API said no" apart from
 * "you typed the command wrong", and it should not have to read English to do
 * it. The table is small on purpose: every command uses these five and nothing
 * else, and the same table is printed by `avsb --help` and documented in
 * content/docs/developer-reference/cli-tool.mdx.
 */

export const EXIT = {
  /** The command did what it said. */
  success: 0,
  /** The command ran and failed: an API refusal, a bad file, a rejected write. */
  failure: 1,
  /** The command was called wrongly: unknown option, missing argument, bad value. */
  usage: 2,
  /** No usable credential, or the platform rejected the one supplied. */
  auth: 3,
  /** The resource moved or is in a state that refuses the change. Re-read and retry. */
  conflict: 4,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** One line per code, printed under `avsb --help`. */
export const EXIT_CODE_HELP = [
  '  0  success',
  '  1  the command ran and failed',
  '  2  the command was called wrongly (unknown option, missing argument)',
  '  3  not logged in, or the platform rejected the token',
  '  4  the resource changed or refuses the change: re-read it and retry',
].join('\n')

/**
 * Which exit code an HTTP status deserves.
 *
 * 401/403 are `auth` so CI can branch straight to "refresh the token" without
 * parsing prose. 409 and 412 are `conflict` so a retry loop can tell a stale
 * write from a broken one. Everything else is a plain failure.
 */
export function exitCodeForStatus(status: number | undefined): ExitCode {
  if (status === 401 || status === 403) return EXIT.auth
  if (status === 409 || status === 412) return EXIT.conflict
  return EXIT.failure
}
