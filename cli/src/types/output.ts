/**
 * The machine-readable output contract: what `--json` prints.
 *
 * One envelope for every command, so a script can be written once and reused:
 *
 *   success  { "ok": true,  "command": "flags list", "data": … }
 *   failure  { "ok": false, "command": "flags list", "error": { … } }
 *
 * `error` is the platform's own error object, passed through unchanged when the
 * failure came from the API (`code`, `message`, `docUrl`, `requestId`,
 * `details`), so the CLI and the REST API speak one vocabulary. Failures that
 * never reached the platform carry a `cli_`-prefixed code instead, which is how
 * you tell "your request was refused" from "the CLI stopped before asking".
 *
 * The envelope is the contract; the exit code is the signal. Both are documented
 * in content/docs/developer-reference/cli-tool.mdx.
 */

/** Codes for failures that happen inside the CLI, before or without a request. */
export type CliErrorCode =
  | 'cli_usage'
  | 'cli_not_logged_in'
  | 'cli_credential_shape'
  | 'cli_no_project'
  | 'cli_no_manifest'
  | 'cli_not_found'
  | 'cli_conflict'
  | 'cli_io_failed'
  | 'cli_failed'
  /** The request never got an answer: DNS, refused, timed out, TLS. */
  | 'cli_network'

export interface JsonErrorBody {
  /**
   * A platform `ApiErrorCode`, one of the `cli_` codes above, or `api_error`
   * when the platform refused on a route that sends no machine code (the
   * older `/api/cli` routes send a bare message).
   */
  code: string
  message: string
  /** Where the code is documented. Present on every platform error. */
  docUrl?: string
  /** Correlation id, matching the platform's `X-Request-Id` response header. */
  requestId?: string
  /** HTTP status, when the failure came from a request. */
  status?: number
  details?: Record<string, unknown>
}

/**
 * Facts about the response rather than the resource itself. Kept beside `data`
 * so `data` stays exactly what the platform returned.
 */
export interface JsonResultMeta {
  /** The resource version, for a later `--if-match` write. */
  etag?: string
  /** Cursor block from a paginated list. */
  page?: { nextCursor: string | null; hasMore: boolean }
}

export interface JsonSuccessEnvelope<T> {
  ok: true
  /** Full command path, for example `flags list`. */
  command: string
  data: T
  meta?: JsonResultMeta
}

export interface JsonErrorEnvelope {
  ok: false
  command: string
  error: JsonErrorBody
}

export type JsonEnvelope<T> = JsonSuccessEnvelope<T> | JsonErrorEnvelope
