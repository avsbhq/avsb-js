// Fetch a FlagDatafile from the CDN.
// Stateless and RSC-safe: no client state, no browser APIs, no 'use client'.

import type { FlagDatafile } from '@avsbhq/core'
import { DEFAULT_CDN_HOST, datafileUrl } from '@avsbhq/core'
import { perRequestCache } from './reactCache'

export interface GetDatafileOptions {
  /** CDN base URL. Default: 'https://cdn.avsb.cloud'. */
  cdnHost?: string
  /** Milliseconds before the request is aborted. Default: 5000. */
  timeoutMs?: number
  /**
   * Seconds Next may serve this datafile from its own fetch cache before
   * revalidating. Default 60, which matches the CDN's own max-age, so a
   * publish is live within about a minute without every render paying a
   * round trip. Pass 0 to always fetch.
   */
  revalidate?: number
  /** Caller-supplied AbortSignal. Takes precedence over `timeoutMs`. */
  signal?: AbortSignal
}

/** Default revalidate window, in seconds. Mirrors the CDN cache header. */
export const DEFAULT_REVALIDATE_SECONDS = 60

/** Next augments `RequestInit` globally; declaring the field we use keeps
 * this compiling with or without those types loaded. */
interface NextFetchInit extends RequestInit {
  next?: { revalidate?: number | false; tags?: string[] }
}

/**
 * Fetch the datafile for an SDK key.
 *
 * ```ts
 * function getDatafile(
 *   sdkKey: string,
 *   options?: GetDatafileOptions,
 * ): Promise<FlagDatafile>
 * ```
 *
 * Two layers of caching, both on by default:
 *
 * - Within one request, `React.cache` deduplicates: ten server components
 *   asking for the same key make one fetch.
 * - Across requests, Next's fetch cache holds the response for
 *   `revalidate` seconds (60 by default).
 *
 * Throws when the response is not 2xx or the request times out, with a
 * message naming the status and the exact URL it tried. `<AvsbRoot>`
 * catches that and renders anyway, so a CDN blip degrades to defaults
 * instead of a blank page.
 */
export async function getDatafile(
  sdkKey: string,
  options?: GetDatafileOptions,
): Promise<FlagDatafile> {
  // datafileUrl is the single source of truth for this URL (spec §1.1).
  // The old hand-built `${cdnHost}/v1/datafile/${sdkKey}` was a path that
  // does not exist and 404s at the edge.
  const url = datafileUrl(sdkKey, options?.cdnHost ?? DEFAULT_CDN_HOST)

  if (options?.signal) {
    return fetchDatafile(url, options.signal, options.revalidate)
  }
  return cachedFetch(url, options?.timeoutMs ?? 5_000, options?.revalidate ?? DEFAULT_REVALIDATE_SECONDS)
}

/**
 * The memoised hop. Keyed on primitives ONLY: `React.cache` compares
 * arguments by identity, so passing the options object through here would
 * miss on every call and silently disable per-request deduplication.
 */
const cachedFetch = perRequestCache(
  async (url: string, timeoutMs: number, revalidate: number): Promise<FlagDatafile> =>
    fetchDatafile(url, AbortSignal.timeout(timeoutMs), revalidate),
)

async function fetchDatafile(
  url: string,
  signal: AbortSignal,
  revalidate?: number,
): Promise<FlagDatafile> {
  const init: NextFetchInit = { signal }
  if (revalidate !== undefined) init.next = { revalidate }

  const response = await fetch(url, init)

  if (!response.ok) {
    throw new Error(
      `[avsb] the datafile request failed with ${response.status} ${response.statusText} for ${url}. ` +
        'A 404 means the SDK key does not match a published environment: check it in ' +
        'Environments in the project sidebar, in the A vs B dashboard, and publish the environment ' +
        'if it has never been published.',
    )
  }

  return (await response.json()) as FlagDatafile
}
