import type { FlagDatafile } from './types'
import { datafileUrl, DEFAULT_CDN_HOST } from '@avsbhq/core'
import { fetchWithTimeout } from './net'

/**
 * Fetch a flag datafile from the CDN for server-side bootstrap.
 * Use this in React Server Components, getServerSideProps, or any Node.js context
 * to pre-fetch the datafile and pass it as bootstrap to AvsbClient or AvsbProvider.
 *
 * The URL comes from the shared endpoint contract (spec §1.1) rather than
 * being composed here, so this helper and the client can never disagree
 * about where a datafile lives.
 *
 * Returns null on any failure (bad key, network, timeout): a server render
 * must not throw because a flag service was slow. `onError` reports what
 * happened when you need to know.
 */
export async function fetchDatafile(
  sdkKey: string,
  options?: {
    cdnHost?: string
    timeout?: number
    onError?: (error: Error) => void
  },
): Promise<FlagDatafile | null> {
  const host = options?.cdnHost ?? DEFAULT_CDN_HOST
  const timeout = options?.timeout ?? 5000

  try {
    const response = await fetchWithTimeout(datafileUrl(sdkKey, host), {
      timeoutMs: timeout,
      what: 'loading the datafile',
    })
    if (!response.ok) {
      options?.onError?.(
        new Error(
          `AvsB datafile request returned HTTP ${response.status} for ` +
            `${datafileUrl(sdkKey, host)}. Server-side bootstrap is skipped, so the ` +
            'browser will fetch the datafile itself.',
        ),
      )
      return null
    }
    return (await response.json()) as FlagDatafile
  } catch (e) {
    options?.onError?.(e instanceof Error ? e : new Error(String(e)))
    return null
  }
}

export type { FlagDatafile } from './types'
