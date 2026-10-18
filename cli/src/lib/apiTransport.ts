/**
 * How the CLI talks to the platform: one place for credentials, headers, error
 * shapes and response metadata.
 *
 * Split out of `api.ts` when that file passed the size limit. Every client in
 * the CLI inherits from here (`ApiClient`, and through it `WebhookApiClient`
 * and `FlagsApiClient`), so the token precedence, the version header, and the
 * two error envelopes are shared rather than copied.
 *
 * What every request carries:
 *   - `Authorization: Bearer <personal access token>`
 *   - `AvsB-API-Version`, accepted with no effect by v1 and there so a future
 *     version cannot silently change what this CLI is served.
 *
 * What every failure becomes: an `ApiRequestError` carrying the platform's
 * machine code, its documentation link, and the request id, so the command that
 * catches it can print all three without re-parsing anything.
 */

import { readEnvApiUrl, readEnvToken, stripTrailingSlash } from './env.js'
import { toApiRequestError } from './apiError.js'
import { CliError } from './cliError.js'
import { describeNetworkFailure, invalidBaseUrl } from './networkError.js'
import { describeTokenProblem } from './tokenShape.js'
import type { ApiClientConfig } from '../types/config.js'

/**
 * The API version this CLI is written against. Sent on every request and
 * accepted (with no effect) by v1, so the day a second version ships this CLI
 * keeps getting v1 responses instead of following a moved contract.
 */
export const API_VERSION = 'v1'
const API_VERSION_HEADER = 'AvsB-API-Version'
const REQUEST_ID_HEADER = 'X-Request-Id'

/** A response body plus the response metadata a caller may need. */
export interface ApiResult<T> {
  body: T
  /** Present on the routes that support optimistic concurrency. */
  etag: string | null
}

/**
 * The answer to a conditional GET: either the body, or "nothing changed".
 *
 * A 304 is an ANSWER, not a failure, which is the whole reason this shape
 * exists next to `ApiResult`. `avsb codegen --watch` polls the datafile on a
 * timer; without this it would either throw on every unchanged poll or
 * re-download the file forever.
 */
export type ConditionalResult<T> =
  | { status: 'not-modified'; etag: string | null }
  | { status: 'ok'; body: T; etag: string | null }

function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host
  } catch {
    return undefined
  }
}

export class ApiTransport {
  private baseUrl: string
  private token: string

  /**
   * `AVSB_TOKEN` and `AVSB_API_URL` win over whatever the caller passes in, so
   * a headless run works even when a stale config file sits on disk.
   * `avsb login --token <t>` passes `useEnvOverrides: false`: it must verify
   * the token the user typed, not the one in the environment.
   */
  constructor(config: ApiClientConfig, options: { useEnvOverrides?: boolean } = {}) {
    const useEnv = options.useEnvOverrides !== false
    const envUrl = useEnv ? readEnvApiUrl() : null
    const envToken = useEnv ? readEnvToken() : null
    this.baseUrl = envUrl ?? stripTrailingSlash(config.apiBaseUrl)
    this.token = envToken ?? config.token
  }

  /**
   * Refuse before the round trip when the credential cannot possibly work, and
   * say which credential was supplied instead. A bare 401 is the worst answer to
   * "I pasted the wrong key".
   */
  private assertUsableToken(): void {
    const problem = describeTokenProblem(this.token)
    if (problem) throw new CliError('cli_credential_shape', problem)
  }

  /**
   * The one place a request leaves this process: credentials, headers, and
   * body parsing. It reports what came back and judges nothing, so both the
   * plain and the conditional paths below share exactly one implementation.
   */
  private async send(path: string, options: RequestInit): Promise<{ res: Response; body: unknown }> {
    this.assertUsableToken()

    // A base URL that is not an address would otherwise fail inside fetch with
    // a message quoting the internal path (and an org id in its query).
    const badUrl = invalidBaseUrl(this.baseUrl)
    if (badUrl) throw badUrl

    const url = `${this.baseUrl}${path}`
    let res: Response
    try {
      res = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
          [API_VERSION_HEADER]: API_VERSION,
          ...options.headers,
        },
      })
    } catch (err) {
      // No answer at all: name the host and the kind of failure instead of
      // fetch's own "fetch failed".
      throw describeNetworkFailure(this.baseUrl, err)
    }

    // A 204 has no body, and an HTML error page from a proxy is not JSON
    // either; neither should reach the user as "Unexpected token < in JSON".
    let body: unknown = null
    const text = await res.text()
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        body = null
      }
    }

    return { res, body }
  }

  private refusal(res: Response, body: unknown): Error {
    return toApiRequestError({
      status: res.status,
      body,
      requestId: res.headers.get(REQUEST_ID_HEADER),
      retryAfter: res.headers.get('Retry-After'),
      host: hostOf(this.baseUrl),
    })
  }

  /**
   * Protected, not public: subclasses reuse the transport, callers use the
   * named methods. Returns the body and the ETag; `request` unwraps it for the
   * common case.
   */
  protected async requestWithMeta<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<ApiResult<T>> {
    const { res, body } = await this.send(path, options)
    if (!res.ok) throw this.refusal(res, body)
    return { body: body as T, etag: res.headers.get('ETag') }
  }

  /**
   * A GET that asks "has this changed?" and accepts "no" for an answer.
   *
   * `etag` is whatever the last response carried; null asks unconditionally.
   * A route that sends no ETag simply never answers 304, and the caller falls
   * back to comparing what it generated. Nothing here assumes the platform
   * supports conditional reads.
   */
  protected async requestIfNoneMatch<T>(
    path: string,
    etag: string | null,
  ): Promise<ConditionalResult<T>> {
    const { res, body } = await this.send(
      path,
      etag ? { headers: { 'If-None-Match': etag } } : {},
    )

    if (res.status === 304) {
      // A 304 may repeat the ETag or omit it; keeping the one we sent means the
      // next poll still asks conditionally either way.
      return { status: 'not-modified', etag: res.headers.get('ETag') ?? etag }
    }
    if (!res.ok) throw this.refusal(res, body)
    return { status: 'ok', body: body as T, etag: res.headers.get('ETag') }
  }

  protected async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const result = await this.requestWithMeta<T>(path, options)
    return result.body
  }
}
