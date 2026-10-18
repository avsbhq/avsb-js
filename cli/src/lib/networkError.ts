/**
 * A request that never got an answer, said in a sentence that names the host
 * and the kind of failure.
 *
 * Node's fetch rejects every transport failure with the same `TypeError: fetch
 * failed` and hides the reason in `cause`, so the CLI used to print "fetch
 * failed" for a mistyped host, a closed port and a dropped connection alike,
 * and `avsb login` called each of them "Token rejected" (QA N4-10). An API URL
 * that is not a URL at all surfaced as "Failed to parse URL from
 * notaurl/api/cli/auth/verify?orgId=…", leaking an internal path and an id.
 *
 * Pure: an error in, a `CliError` out, so every branch is tested without a
 * network.
 */

import { CliError } from './cliError.js'

export type NetworkFailureKind = 'dns' | 'refused' | 'timeout' | 'reset' | 'tls' | 'other'

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EAI_FAIL'])
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ESOCKETTIMEDOUT'])
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ECONNABORTED'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The first `code` found on the error or anywhere down its `cause` chain. */
export function networkErrorCode(err: unknown): string | null {
  let current: unknown = err
  for (let depth = 0; depth < 5 && isRecord(current); depth++) {
    if (typeof current.code === 'string') return current.code
    // undici wraps a failed connection to every resolved address in an
    // AggregateError; any one of them carries the code.
    if (Array.isArray(current.errors)) {
      for (const inner of current.errors) {
        const code = networkErrorCode(inner)
        if (code) return code
      }
    }
    current = current.cause
  }
  return null
}

/**
 * The most specific message in the cause chain. fetch's own "fetch failed" is
 * skipped: undici puts the real reason ("bad port", "other side closed") in
 * `cause`.
 */
export function networkErrorReason(err: unknown): string | null {
  let current: unknown = err
  let reason: string | null = null
  for (let depth = 0; depth < 5 && isRecord(current); depth++) {
    const message = current.message
    if (typeof message === 'string' && message.length > 0 && message !== 'fetch failed') reason = message
    current = current.cause
  }
  return reason
}

export function classifyNetworkError(code: string | null): NetworkFailureKind {
  if (code === null) return 'other'
  if (DNS_CODES.has(code)) return 'dns'
  if (code === 'ECONNREFUSED') return 'refused'
  if (TIMEOUT_CODES.has(code)) return 'timeout'
  if (RESET_CODES.has(code)) return 'reset'
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) return 'tls'
  return 'other'
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

/** The CLI error for a request to `baseUrl` that failed before any answer. */
export function describeNetworkFailure(baseUrl: string, err: unknown): CliError {
  const host = hostOf(baseUrl)
  const code = networkErrorCode(err)
  const kind = classifyNetworkError(code)
  const urlHint = `The API URL in use is ${baseUrl}. Check AVSB_API_URL, or the URL \`avsb login --url\` saved.`
  const networkHint = 'Check your network connection, VPN or proxy.'

  switch (kind) {
    case 'dns':
      return new CliError('cli_network', `Cannot find ${host}: the name does not resolve (DNS lookup failed).`, [urlHint, networkHint])
    case 'refused':
      return new CliError('cli_network', `Nothing is listening at ${host}: the connection was refused.`, [urlHint])
    case 'timeout':
      return new CliError('cli_network', `${host} did not answer in time (the connection timed out).`, [networkHint])
    case 'reset':
      return new CliError('cli_network', `${host} closed the connection before answering.`, [networkHint])
    case 'tls':
      return new CliError('cli_network', `Could not make a secure connection to ${host} (${code}).`, [
        'A proxy or antivirus that inspects HTTPS can cause this. Check its certificate settings.',
      ])
    case 'other': {
      const reason = code ?? networkErrorReason(err) ?? 'no answer'
      return new CliError('cli_network', `Could not reach ${host} (${reason}).`, [urlHint, networkHint])
    }
  }
}

/** A usage error when the API URL is not an http(s) address at all, else null. */
export function invalidBaseUrl(baseUrl: string): CliError | null {
  let protocol = ''
  try {
    protocol = new URL(baseUrl).protocol
  } catch {
    protocol = ''
  }
  if (protocol === 'http:' || protocol === 'https:') return null
  return new CliError('cli_usage', `"${baseUrl}" is not a valid API URL.`, [
    'Use a full address such as https://app.avsb.cloud, in AVSB_API_URL or `avsb login --url`.',
  ])
}
