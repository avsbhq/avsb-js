/**
 * Validating list paging flags before they reach the wire.
 *
 * `--limit abc` used to become `limit=NaN` in the query string, which the
 * platform answers with a `pagination_invalid` round trip. The value is the
 * caller's mistake, so the CLI says so locally, as a usage error (exit 2).
 *
 * The bounds mirror `app/_lib/contracts/pagination.ts` (`MAX_LIST_LIMIT`), so a
 * value this accepts is one the API accepts.
 */

import { CliError } from './cliError.js'
import { failCommand } from './output.js'

/** Public-API list ceiling (`MAX_LIST_LIMIT` in contracts/pagination.ts). */
export const MAX_LIST_LIMIT = 100

/**
 * Decide a `--limit` value, or explain why it is not one. Pure, so the rule is
 * testable without a process; `parseLimitOption` is what commands call.
 *
 * `max` differs per route: the public API caps lists at 100, the older CLI
 * metric-binding route at 500.
 */
export function validateLimit(
  raw: string | undefined,
  max: number = MAX_LIST_LIMIT,
): { ok: true; limit: number | undefined } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, limit: undefined }

  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > max) {
    return {
      ok: false,
      message: `Invalid --limit "${raw}". Pass a whole number between 1 and ${max}.`,
    }
  }
  return { ok: true, limit: value }
}

/** Parse `--limit`, or exit 2 explaining the range. Undefined stays undefined. */
export function parseLimitOption(
  raw: string | undefined,
  max: number = MAX_LIST_LIMIT,
): number | undefined {
  const result = validateLimit(raw, max)
  if (!result.ok) failCommand(new CliError('cli_usage', result.message))
  return result.limit
}
