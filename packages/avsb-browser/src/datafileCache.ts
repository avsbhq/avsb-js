// =====================================================================
// localStorage datafile cache with ETag support (WS2 item 3, report 02 §6).
//
// Two problems this solves:
//
// 1. Cold start. Every page load re-downloaded the datafile before a
//    single flag could be read, so the first paint of every session was
//    either delayed or served defaults. With a cache the SDK is readable
//    SYNCHRONOUSLY on the second load, and the network refresh happens
//    behind it (cache-then-network).
// 2. Egress. The cached ETag rides the refresh as `If-None-Match`, so an
//    unchanged datafile costs a 304 with no body instead of the whole
//    document on every poll. The CDN worker's conditional-request handling
//    was fixed in the endpoint-contract session, which is why this can be
//    trusted now.
//
// Storage is best-effort in both directions. Reads validate the shape
// before trusting it (a half-written or foreign value must never crash
// init) and writes swallow quota errors: a browser that refuses to store
// simply gets the pre-cache behaviour.
// =====================================================================

import { datafileShapeProblem } from '@avsbhq/core'
import type { FlagDatafile, Logger } from '@avsbhq/core'

/** Bumped when the stored envelope shape changes, invalidating old entries. */
const CACHE_FORMAT = 1

const KEY_PREFIX = 'avsb_datafile_'

/** A week. Older than this and we prefer defaults-until-network over lies. */
export const DEFAULT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface CacheEnvelope {
  format: number
  sdkKey: string
  etag: string | null
  storedAt: number
  datafile: FlagDatafile
}

export interface CachedDatafile {
  datafile: FlagDatafile
  /** ETag of the response this datafile came from, for `If-None-Match`. */
  etag: string | null
  /** ms-epoch when it was written. */
  storedAt: number
  /** ms since it was written, at read time. */
  ageMs: number
}

export function cacheKeyFor(sdkKey: string): string {
  return `${KEY_PREFIX}${sdkKey}`
}

function safeGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function safeRemove(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(key)
  } catch {
    // Nothing to do: an unremovable entry is re-validated on next read.
  }
}

/**
 * Minimal structural check. The cache is attacker-reachable in the sense
 * that anything on the page can write localStorage, so a cached value is
 * treated as untrusted input: it must look like a flag datafile before the
 * evaluator is pointed at it.
 */
function isDatafileShaped(value: unknown): value is FlagDatafile {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<FlagDatafile>
  return (
    typeof candidate.sdkKey === 'string' &&
    typeof candidate.publishedAt === 'string' &&
    typeof candidate.collectEndpoint === 'string' &&
    // Every array the evaluator reads, down to each rule (N0-15), so a
    // corrupted entry is discarded here instead of throwing from a read.
    datafileShapeProblem(value) === null
  )
}

export interface ReadCacheOptions {
  maxAgeMs?: number
  logger?: Logger
}

/**
 * Read the cached datafile for this SDK key. Returns null when there is
 * nothing usable: no entry, wrong format, wrong key, malformed, or older
 * than `maxAgeMs`. A rejected entry is deleted so it cannot be re-parsed
 * on every load.
 */
export function readCachedDatafile(
  sdkKey: string,
  options: ReadCacheOptions = {},
): CachedDatafile | null {
  const key = cacheKeyFor(sdkKey)
  const raw = safeGet(key)
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    options.logger?.debug('discarded an unparseable cached datafile', { key })
    safeRemove(key)
    return null
  }

  const envelope = parsed as Partial<CacheEnvelope>
  if (
    envelope?.format !== CACHE_FORMAT ||
    envelope.sdkKey !== sdkKey ||
    typeof envelope.storedAt !== 'number' ||
    !isDatafileShaped(envelope.datafile)
  ) {
    options.logger?.debug('discarded a cached datafile that failed validation', {
      key,
    })
    safeRemove(key)
    return null
  }

  const maxAgeMs = options.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS
  const ageMs = Math.max(0, Date.now() - envelope.storedAt)
  if (ageMs > maxAgeMs) {
    options.logger?.debug('discarded a cached datafile older than the max age', {
      key,
      ageMs,
      maxAgeMs,
    })
    // Evict only what is dead by the DEFAULT window. A caller asking for a
    // narrower one is judging this read, not condemning the entry: two clients
    // on the same page can carry different `cacheMaxAgeMs`, and the stricter one
    // used to delete the copy the other could still serve.
    if (ageMs > DEFAULT_CACHE_MAX_AGE_MS) safeRemove(key)
    return null
  }

  return {
    datafile: envelope.datafile,
    etag: typeof envelope.etag === 'string' ? envelope.etag : null,
    storedAt: envelope.storedAt,
    ageMs,
  }
}

/**
 * Cache a datafile fetched from the network.
 *
 * Only network responses are cached: a constructor `bootstrap` is the
 * caller's own data and caching it would let one SSR render pin a stale
 * datafile into a returning visitor's browser for a week.
 */
export function writeCachedDatafile(
  sdkKey: string,
  entry: { datafile: FlagDatafile; etag: string | null },
  logger?: Logger,
): void {
  const envelope: CacheEnvelope = {
    format: CACHE_FORMAT,
    sdkKey,
    etag: entry.etag,
    storedAt: Date.now(),
    datafile: entry.datafile,
  }

  let serialised: string
  try {
    serialised = JSON.stringify(envelope)
  } catch {
    logger?.debug('skipped caching a datafile that would not serialise')
    return
  }

  if (!safeSet(cacheKeyFor(sdkKey), serialised)) {
    logger?.debug('skipped caching the datafile: browser storage refused the write')
  }
}

/** Refresh the stored timestamp and ETag after a 304, keeping the body. */
export function touchCachedDatafile(
  sdkKey: string,
  etag: string | null,
  logger?: Logger,
): void {
  const existing = readCachedDatafile(sdkKey, { logger })
  if (!existing) return
  writeCachedDatafile(
    sdkKey,
    { datafile: existing.datafile, etag: etag ?? existing.etag },
    logger,
  )
}

export function clearCachedDatafile(sdkKey: string): void {
  safeRemove(cacheKeyFor(sdkKey))
}
