/**
 * One error type for everything the platform refuses, and the rules for turning
 * a response into it.
 *
 * The platform speaks two envelopes and the CLI has to read both:
 *
 *   /api/v1      { "error": { "code", "message", "docUrl", "requestId", "details" } }
 *   /api/cli     { "error": "message" }
 *
 * Everything the richer envelope carries is kept: the machine `code` drives the
 * exit code, `docUrl` is printed so an unfamiliar refusal is one click from its
 * meaning, and `requestId` is printed so a support question can name the exact
 * request. None of it is invented — a field the platform did not send stays
 * undefined rather than being guessed at.
 */

import { describeErrorDetails, type PathLabeller } from './apiErrorDetails.js'
import { EXIT, exitCodeForStatus, type ExitCode } from './exitCodes.js'
import { CREDENTIAL_NAMES } from './tokenShape.js'

export interface ApiRequestErrorInit {
  status: number
  message: string
  code?: string
  docUrl?: string
  requestId?: string
  details?: Record<string, unknown>
  retryAfterSeconds?: number
}

export class ApiRequestError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly docUrl: string | undefined
  readonly requestId: string | undefined
  readonly details: Record<string, unknown> | undefined
  readonly retryAfterSeconds: number | undefined

  constructor(init: ApiRequestErrorInit) {
    super(init.message)
    this.name = 'ApiRequestError'
    this.status = init.status
    this.code = init.code
    this.docUrl = init.docUrl
    this.requestId = init.requestId
    this.details = init.details
    this.retryAfterSeconds = init.retryAfterSeconds
  }

  /** Which process exit code this refusal deserves. */
  get exitCode(): ExitCode {
    return exitCodeForStatus(this.status)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseRetryAfter(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined
  const seconds = Number.parseInt(raw, 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

/**
 * Build the error for a non-2xx response. Pure, so every branch is testable
 * without a network: pass the parsed body and the two headers that matter.
 */
export function toApiRequestError(input: {
  status: number
  body: unknown
  requestId?: string | null
  retryAfter?: string | null
  /** The host that answered, named when the answer is not the platform's. */
  host?: string
}): ApiRequestError {
  const retryAfterSeconds = parseRetryAfter(input.retryAfter)
  const headerRequestId = asString(input.requestId ?? undefined)

  if (isRecord(input.body)) {
    const raw = input.body.error

    // Public API envelope.
    if (isRecord(raw)) {
      return new ApiRequestError({
        status: input.status,
        message: asString(raw.message) ?? `API error ${input.status}`,
        code: asString(raw.code),
        docUrl: asString(raw.docUrl),
        requestId: asString(raw.requestId) ?? headerRequestId,
        details: isRecord(raw.details) ? raw.details : undefined,
        retryAfterSeconds,
      })
    }

    // Legacy CLI-route envelope: a bare string, no code and no doc link. Those
    // routes put their extra context in SIBLING top-level fields (the metric
    // delete route sends `metricsReferencing` next to `error`), so keep them:
    // the alternative is what the CLI used to do, which was regex the message.
    const message = asString(raw)
    if (message) {
      const siblings: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(input.body)) {
        if (key !== 'error') siblings[key] = value
      }
      return new ApiRequestError({
        status: input.status,
        message,
        requestId: headerRequestId,
        details: Object.keys(siblings).length > 0 ? siblings : undefined,
        retryAfterSeconds,
      })
    }
  }

  // Not the platform's envelope: a proxy page, a wrong path, another server.
  // Saying which host answered is what points at a mistyped API URL (N4-10).
  return new ApiRequestError({
    status: input.status,
    message: input.host
      ? `${input.host} answered HTTP ${input.status}, which is not an A vs B API response. Check the API URL.`
      : `API error ${input.status}`,
    requestId: headerRequestId,
    retryAfterSeconds,
  })
}

/**
 * The extra lines printed under the error message: why it failed (the field
 * or file), what to do about it, where it is documented, and which request it
 * was.
 *
 * Kept as data (an array of lines) so the same advice can be asserted in tests
 * and reused by any command without each one re-deciding what to say. Pass
 * `labelForPath` when the command can name the local file a request-body path
 * refers to.
 */
export function describeApiFailure(error: ApiRequestError, labelForPath?: PathLabeller): string[] {
  const lines: string[] = describeErrorDetails(error.details, labelForPath)

  if (error.status === 401) {
    lines.push(
      `Check the credential: the CLI signs in with a ${CREDENTIAL_NAMES.personalAccessToken} (${CREDENTIAL_NAMES.personalAccessTokenPrefix}…). Run \`avsb whoami\` to see which one is in use, or \`avsb login\` to replace it.`,
    )
  }

  if (error.status === 403 && error.code === 'scope_missing') {
    lines.push(
      'Your role in this organization does not allow this action. A personal access token gets the permissions of your role.',
    )
  }

  if (error.status === 412) {
    const expected = error.details?.expected
    lines.push('The resource changed since it was read. Re-read it and run the command again.')
    if (typeof expected === 'string') {
      lines.push(`Current version: ${expected}`)
    }
  }

  if (error.status === 429 && error.retryAfterSeconds !== undefined) {
    lines.push(`Rate limited. Retry in ${error.retryAfterSeconds}s.`)
  }

  if (error.docUrl) lines.push(`Docs: ${error.docUrl}`)
  if (error.requestId) lines.push(`Request id: ${error.requestId}`)

  return lines
}

/** Exit code for anything a command catches, whether or not it came from the API. */
export function exitCodeForError(error: unknown): ExitCode {
  return error instanceof ApiRequestError ? error.exitCode : EXIT.failure
}
