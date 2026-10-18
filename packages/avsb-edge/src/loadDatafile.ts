// =====================================================================
// The init pipeline: cache, network, and the InitResult decision.
//
// Extracted from AvsbEdgeClient so the readiness contract (spec §1.2,
// breaking change B1) reads as one ordered function instead of being spread
// across five private methods, and so it can be tested without a client.
//
// THE ORDER, and what each exit means:
//
//   fresh cached datafile         success, origin 'cache'
//   network fetch ok              success, origin 'network'
//   fetch failed, stale cache     success + DEGRADED, origin 'staleCache'
//   fetch failed, nothing cached  FAILURE
//
// `degraded: true` is produced here and nowhere else. It means exactly one
// thing: the SDK is serving a stale cached datafile after a failed refresh.
//
// FRESHNESS LIVES HERE, NOT IN THE STORAGE ADAPTERS. A store that hard
// expired an entry at the freshness window would delete the very copy the
// degraded path needs, so adapters keep entries for a long RETENTION window
// and this function decides whether one is fresh enough to serve. That split
// is what makes the degraded exit reachable at all.
// =====================================================================

import { datafileShapeProblem } from '@avsbhq/core'
import type { FlagDatafile, InitResult, Logger } from '@avsbhq/core'
import type { UnifiedStorageAdapter } from '@avsbhq/utils'
import { datafileRequestUrl, fetchDatafileFromCdn } from './core'
import {
  datafileHttpFailureMessage,
  datafileUnavailableMessage,
  malformedDatafileMessage,
  servingStaleCacheMessage,
} from './messages'
import type { EdgeErrorSource } from './types'

/** Where the datafile in memory came from. Drives logs and the heartbeat. */
export type DatafileOrigin = 'bootstrap' | 'cache' | 'network' | 'staleCache'

export interface LoadDatafileInput {
  sdkKey: string
  cdnHost?: string
  /** Ms budget for one datafile request. */
  timeoutMs: number
  /** How long a cached copy counts as fresh. Zero or less always revalidates. */
  cacheTtlMs: number
  storage?: UnifiedStorageAdapter
  /** Replaces the built-in CDN fetch. Null means "could not get it". */
  fetchDatafile?: (sdkKey: string) => Promise<FlagDatafile | null>
  logger: Logger
  /** Surfaces an error to the logger and the caller's `onError`. */
  report: (error: Error, source: EdgeErrorSource) => void
  /** Hands background work to `waitUntil`, or to the pending list. */
  defer: (work: Promise<unknown>) => void
}

export interface LoadDatafileOutcome {
  result: InitResult
  datafile: FlagDatafile | null
  origin: DatafileOrigin | null
}

type CacheEntry = { datafile: FlagDatafile; cachedAt: number }

async function readCache(input: LoadDatafileInput): Promise<CacheEntry | null> {
  if (!input.storage) return null
  try {
    const entry = await input.storage.datafileGet(input.sdkKey)
    if (!entry) return null
    // A corrupted entry is discarded, never served (N0-15).
    const problem = datafileShapeProblem(entry.datafile)
    if (problem) {
      const url = datafileRequestUrl(input.sdkKey, input.cdnHost)
      input.report(new Error(malformedDatafileMessage('cache', problem, url)), 'cache')
      return null
    }
    return entry
  } catch (e) {
    // A broken cache must never take the request down: fall through to the
    // network and say what happened.
    input.report(e instanceof Error ? e : new Error(String(e)), 'cache')
    return null
  }
}

function writeCache(input: LoadDatafileInput, datafile: FlagDatafile): void {
  if (!input.storage) return
  const write = input.storage.datafileSet(input.sdkKey, datafile).catch((e: unknown) => {
    input.report(e instanceof Error ? e : new Error(String(e)), 'cache')
  })
  input.defer(write)
}

/** Fetch, normalising both transports into "a datafile, or an error to report". */
async function fetchOnce(
  input: LoadDatafileInput,
  url: string,
): Promise<{ datafile: FlagDatafile } | { error: Error }> {
  const attempt = await fetchAny(input, url)
  if ('error' in attempt) return attempt
  // JSON that parses but is not a datafile must never reach the evaluator,
  // whichever transport delivered it (N0-15).
  const problem = datafileShapeProblem(attempt.datafile)
  return problem
    ? { error: new Error(malformedDatafileMessage('network', problem, url)) }
    : attempt
}

async function fetchAny(
  input: LoadDatafileInput,
  url: string,
): Promise<{ datafile: FlagDatafile } | { error: Error }> {
  if (input.fetchDatafile) {
    try {
      const datafile = await input.fetchDatafile(input.sdkKey)
      return datafile ? { datafile } : { error: new Error(datafileUnavailableMessage(url)) }
    } catch (e) {
      return { error: e instanceof Error ? e : new Error(String(e)) }
    }
  }

  const outcome = await fetchDatafileFromCdn(input.sdkKey, {
    cdnHost: input.cdnHost,
    timeoutMs: input.timeoutMs,
  })
  if (outcome.kind === 'datafile') return { datafile: outcome.datafile }
  if (outcome.kind === 'httpError') {
    return { error: new Error(datafileHttpFailureMessage(outcome.status, outcome.url)) }
  }
  return { error: outcome.error }
}

/**
 * Resolve a datafile for this request. Never rejects: every failure comes
 * back as an `InitResult` with `success: false` or `degraded: true`.
 */
export async function loadDatafile(input: LoadDatafileInput): Promise<LoadDatafileOutcome> {
  const url = datafileRequestUrl(input.sdkKey, input.cdnHost)
  const cached = await readCache(input)
  const fresh = cached !== null && input.cacheTtlMs > 0 && Date.now() - cached.cachedAt < input.cacheTtlMs

  if (cached && fresh) {
    input.logger.debug('datafile served from cache', { ageMs: Date.now() - cached.cachedAt })
    // `InitResult.source` has no 'cache' member (it is core-owned and
    // deliberately narrow), and a cache hit is a locally-held datafile, so it
    // reports as 'bootstrap'. `origin` is what tells the two apart, and it is
    // why no heartbeat is sent for a cache hit.
    return {
      result: { success: true, source: 'bootstrap' },
      datafile: cached.datafile,
      origin: 'cache',
    }
  }

  const attempt = await fetchOnce(input, url)

  if ('datafile' in attempt) {
    writeCache(input, attempt.datafile)
    return {
      result: { success: true, source: 'network' },
      datafile: attempt.datafile,
      origin: 'network',
    }
  }

  input.report(attempt.error, 'init')

  if (cached) {
    input.logger.warn(servingStaleCacheMessage(url, Date.now() - cached.cachedAt))
    return {
      result: { success: true, degraded: true, source: 'error', error: attempt.error },
      datafile: cached.datafile,
      origin: 'staleCache',
    }
  }

  // B1: no datafile and no fallback is a FAILED init. This used to resolve as
  // a silent success with every flag serving its default value.
  return {
    result: { success: false, source: 'error', error: attempt.error },
    datafile: null,
    origin: null,
  }
}
