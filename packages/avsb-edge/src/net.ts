// =====================================================================
// fetch with a real timeout and named-host errors.
//
// The edge datafile fetch had no timeout and a bare `catch { return null }`
// (report 02 §5.1 area, core.ts:28-40). Its own comment argued that edge
// runtimes enforce a wall clock so a timeout was unnecessary, which gets
// the trade backwards: the runtime's limit kills the WHOLE REQUEST, so a
// stalled CDN connection took the customer's page down with it instead of
// falling back to defaults. A short client-side budget is what turns that
// into "serve defaults, log why".
//
// Every network error raised here names the host and what was being
// attempted, because "TypeError: Failed to fetch" tells a developer
// nothing about which A vs B host was unreachable.
//
// `AbortSignal.timeout()` is deliberately not used: Fastly Compute and
// older Node runtimes on Lambda@Edge do not ship it, and an AbortController
// plus a timer works on all seven runtimes.
//
// This is a deliberate near-copy of packages/avsb-browser/src/net.ts (the
// browser variant also mentions ad blockers and connect-src, which do not
// apply server-side). Consolidating both into @avsbhq/core is reported as
// owed work; the edge package cannot depend on @avsbhq/browser.
// =====================================================================

/** Error raised when a request exceeds its timeout. */
export class AvsbEdgeTimeoutError extends Error {
  readonly host: string
  readonly timeoutMs: number

  constructor(host: string, timeoutMs: number, what: string) {
    super(
      `AvsB timed out after ${timeoutMs}ms while ${what} from ${host}. The host ` +
        'answered too slowly or the connection stalled. Nothing was changed, and ' +
        'the SDK keeps serving the values it already has. Raise timeoutMs if this ' +
        'host is reliably slower than that from your region.',
    )
    this.name = 'AvsbEdgeTimeoutError'
    this.host = host
    this.timeoutMs = timeoutMs
  }
}

/** Error raised when the request never reached the host at all. */
export class AvsbEdgeNetworkError extends Error {
  readonly host: string

  constructor(host: string, what: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `AvsB could not reach ${host} while ${what} (${detail}). On an edge ` +
        'runtime the usual causes are no outbound network access from the ' +
        'function, a platform egress restriction, or DNS failing inside the ' +
        'sandbox. The SDK keeps serving the values it already has.',
    )
    this.name = 'AvsbEdgeNetworkError'
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
 * `AvsbEdgeTimeoutError` / `AvsbEdgeNetworkError` so callers log one useful
 * line instead of a bare TypeError.
 *
 * A non-2xx response is returned, not thrown: the caller decides what a 404
 * means.
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions,
): Promise<Response> {
  const host = hostOf(url)

  if (typeof fetch !== 'function') {
    throw new AvsbEdgeNetworkError(
      host,
      options.what,
      'fetch is not available in this environment',
    )
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null
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
    if (timedOut) throw new AvsbEdgeTimeoutError(host, options.timeoutMs, options.what)
    throw new AvsbEdgeNetworkError(host, options.what, e)
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Read a response header without assuming a full `Headers` implementation. */
export function headerOf(response: Response, name: string): string | null {
  // Test doubles and non-standard fetch polyfills hand back bare
  // `{ ok, status, json }` objects with no headers at all.
  return typeof response.headers?.get === 'function' ? response.headers.get(name) : null
}
