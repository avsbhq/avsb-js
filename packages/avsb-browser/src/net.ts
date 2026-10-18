// =====================================================================
// Fetch with a real timeout and named-host errors (report 02 §5.10).
//
// The browser client's datafile fetch had NO timeout: `onReady()` could
// hang forever on a stalled connection, which in a framework adapter
// means a loading state that never resolves. The SSR helper already had
// an AbortController; the client did not.
//
// Every network error raised here names the host and what was being
// attempted, because "TypeError: Failed to fetch" tells a developer
// nothing about which of the three A vs B hosts was unreachable or that
// an ad blocker or a Content Security Policy is the usual cause.
//
// `AbortSignal.timeout()` is deliberately not used: it is missing in
// browsers that still satisfy this package's ES2020 target, and an
// AbortController plus a timer works everywhere.
// =====================================================================

/** Error raised when a request exceeds its timeout. */
export class AvsbTimeoutError extends Error {
  readonly host: string
  readonly timeoutMs: number

  constructor(host: string, timeoutMs: number, what: string) {
    super(
      `AvsB timed out after ${timeoutMs}ms while ${what} from ${host}. ` +
        'The host answered too slowly or the connection stalled. Nothing was ' +
        'changed, and the SDK keeps serving the values it already has.',
    )
    this.name = 'AvsbTimeoutError'
    this.host = host
    this.timeoutMs = timeoutMs
  }
}

/** Error raised when the request never reached the host at all. */
export class AvsbNetworkError extends Error {
  readonly host: string

  constructor(host: string, what: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `AvsB could not reach ${host} while ${what} (${detail}). Common causes: ` +
        'no network, an ad blocker or privacy extension, or a Content Security ' +
        `Policy that does not allow connect-src ${host}. The SDK keeps serving ` +
        'the values it already has.',
    )
    this.name = 'AvsbNetworkError'
    this.host = host
  }
}

/** Host label for a URL, falling back to the raw string for odd inputs. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export interface FetchWithTimeoutOptions {
  timeoutMs: number
  /** Verb phrase used in error messages, e.g. 'loading the datafile'. */
  what: string
  init?: RequestInit
}

/**
 * fetch with an AbortController timeout, normalising failures into
 * `AvsbTimeoutError` / `AvsbNetworkError` so callers can log one useful
 * line instead of a bare TypeError.
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions,
): Promise<Response> {
  const host = hostOf(url)

  if (typeof fetch !== 'function') {
    throw new AvsbNetworkError(host, options.what, 'fetch is not available in this environment')
  }

  const controller =
    typeof AbortController === 'function' ? new AbortController() : null
  let timedOut = false
  const timer =
    controller && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, options.timeoutMs)
      : null

  try {
    return await fetch(url, {
      ...options.init,
      ...(controller ? { signal: controller.signal } : {}),
    })
  } catch (e) {
    if (timedOut) throw new AvsbTimeoutError(host, options.timeoutMs, options.what)
    throw new AvsbNetworkError(host, options.what, e)
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
