// =====================================================================
// Conditional datafile transport (spec §1.1 + WS2 item 3).
//
// One function, no client state, so the three things that were wrong here
// are each provably fixed and directly testable:
//
//   1. The URL comes from `datafileUrl` in @avsbhq/core, the single source
//      of truth for data-plane targets. Nothing is composed by hand.
//   2. The request has a timeout (AbortController), so `onReady()` cannot
//      hang forever on a stalled connection.
//   3. A cached ETag rides as `If-None-Match`, so an unchanged datafile
//      costs a 304 with no body instead of the whole document per poll.
//
// A non-2xx status is DATA (the caller decides what a 404 means), while a
// network failure or timeout THROWS, carrying a message that names the
// host and the likely cause.
// =====================================================================

import { datafileShapeProblem, datafileUrl } from '@avsbhq/core'
import type { FlagDatafile } from '@avsbhq/core'
import { fetchWithTimeout, hostOf } from './net'

/** What one datafile request produced. */
export type DatafileFetchOutcome =
  | { kind: 'datafile'; datafile: FlagDatafile; etag: string | null }
  | { kind: 'notModified'; etag: string | null }
  | { kind: 'httpError'; status: number; url: string }

export interface DatafileFetchInput {
  sdkKey: string
  cdnHost: string
  /** ETag of the copy already held, sent as `If-None-Match` when present. */
  etag?: string | null
  timeoutMs: number
}

/**
 * The URL this SDK key resolves to. Exported so error messages and logs can
 * name the exact address that was tried.
 */
export function datafileRequestUrl(sdkKey: string, cdnHost: string): string {
  try {
    return datafileUrl(sdkKey, cdnHost)
  } catch {
    // `datafileUrl` throws only for an empty key, which the key-shape check
    // has already reported. Keep a printable value for messages.
    return `${cdnHost}/${sdkKey}/datafile.json`
  }
}

/** Read a response header without assuming a full `Headers` implementation. */
function headerOf(response: Response, name: string): string | null {
  // Test doubles and non-standard fetch polyfills hand back bare
  // `{ ok, status, json }` objects with no headers at all.
  return typeof response.headers?.get === 'function' ? response.headers.get(name) : null
}

export async function fetchDatafileConditional(
  input: DatafileFetchInput,
): Promise<DatafileFetchOutcome> {
  const url = datafileRequestUrl(input.sdkKey, input.cdnHost)
  const headers: Record<string, string> = {}
  if (input.etag) headers['If-None-Match'] = input.etag

  const response = await fetchWithTimeout(url, {
    timeoutMs: input.timeoutMs,
    what: 'loading the datafile',
    init: Object.keys(headers).length > 0 ? { headers } : undefined,
  })

  const etag = headerOf(response, 'etag')

  if (response.status === 304) return { kind: 'notModified', etag }
  if (!response.ok) return { kind: 'httpError', status: response.status, url }

  let datafile: FlagDatafile
  try {
    datafile = (await response.json()) as FlagDatafile
  } catch (e) {
    // A 2xx whose body is not JSON is the one path here that used to fail
    // quietly, surfacing a bare SyntaxError with no host or URL in it. In the
    // wild it means something answered FOR the host: a proxy error page, a
    // captive portal, or a blocking extension.
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(
      `AvsB got a response from ${hostOf(url)} that is not a valid datafile ` +
        `(${detail}). ${url} returned HTTP ${response.status}, but the body could not ` +
        'be parsed as JSON, which usually means a proxy error page, a captive portal, ' +
        'or a blocking extension answered instead of the CDN. Open that URL in a ' +
        'browser tab to see what came back. The SDK keeps serving the values it ' +
        'already has.',
    )
  }
  // A body that parses but is not a datafile (an error object from a proxy,
  // a truncated document) must never reach the evaluator (N0-15).
  const problem = datafileShapeProblem(datafile)
  if (problem) {
    throw new Error(
      `AvsB got a response from ${hostOf(url)} that is not a valid datafile ` +
        `(${problem}). ${url} returned HTTP ${response.status} with JSON that is not ` +
        'a datafile, which usually means a proxy or a blocking extension answered ' +
        'instead of the CDN. Open that URL in a browser tab to see what came back. ' +
        'The SDK keeps serving the values it already has.',
    )
  }
  return { kind: 'datafile', datafile, etag }
}
