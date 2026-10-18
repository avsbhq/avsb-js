import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlagDatafile } from '@avsbhq/core'
import {
  DEFAULT_CACHE_MAX_AGE_MS,
  cacheKeyFor,
  clearCachedDatafile,
  readCachedDatafile,
  touchCachedDatafile,
  writeCachedDatafile,
} from './datafileCache'

const SDK_KEY = 'sdk_production_cachetest0000000000'

function datafile(overrides?: Partial<FlagDatafile>): FlagDatafile {
  return {
    version: 1,
    projectType: 'FEATURE_FLAG',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
    publishedAt: '2026-01-01T00:00:00Z',
    collectEndpoint: 'https://collect.test.invalid',
    flags: [],
    audiences: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('writeCachedDatafile / readCachedDatafile', () => {
  it('round-trips a datafile with its ETag', () => {
    writeCachedDatafile(SDK_KEY, { datafile: datafile(), etag: 'W/"abc"' })

    const cached = readCachedDatafile(SDK_KEY)

    expect(cached?.datafile.publishedAt).toBe('2026-01-01T00:00:00Z')
    expect(cached?.etag).toBe('W/"abc"')
    expect(cached?.ageMs).toBeGreaterThanOrEqual(0)
  })

  it('scopes the entry to the SDK key so a second environment cannot read it', () => {
    writeCachedDatafile(SDK_KEY, { datafile: datafile(), etag: null })

    expect(readCachedDatafile('sdk_development_other000000000000')).toBeNull()
    expect(readCachedDatafile(SDK_KEY)).not.toBeNull()
  })

  it('rejects and deletes an entry that is not shaped like a datafile', () => {
    // Anything on the page can write localStorage, so a cached value is
    // untrusted input: it must never reach the evaluator unvalidated.
    localStorage.setItem(
      cacheKeyFor(SDK_KEY),
      JSON.stringify({ format: 1, sdkKey: SDK_KEY, storedAt: Date.now(), datafile: { nope: true } }),
    )

    expect(readCachedDatafile(SDK_KEY)).toBeNull()
    expect(localStorage.getItem(cacheKeyFor(SDK_KEY))).toBeNull()
  })

  it('rejects and deletes unparseable JSON', () => {
    localStorage.setItem(cacheKeyFor(SDK_KEY), '{not json')

    expect(readCachedDatafile(SDK_KEY)).toBeNull()
    expect(localStorage.getItem(cacheKeyFor(SDK_KEY))).toBeNull()
  })

  it('rejects an entry older than the max age', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now - DEFAULT_CACHE_MAX_AGE_MS - 1000)
    writeCachedDatafile(SDK_KEY, { datafile: datafile(), etag: null })

    vi.spyOn(Date, 'now').mockReturnValue(now)
    expect(readCachedDatafile(SDK_KEY)).toBeNull()
  })

  it('honours a caller-supplied max age', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now - 60_000)
    writeCachedDatafile(SDK_KEY, { datafile: datafile(), etag: null })

    vi.spyOn(Date, 'now').mockReturnValue(now)
    expect(readCachedDatafile(SDK_KEY, { maxAgeMs: 30_000 })).toBeNull()
    expect(readCachedDatafile(SDK_KEY, { maxAgeMs: 120_000 })).not.toBeNull()
  })

  it('survives a browser that refuses to store, without throwing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
      removeItem: () => undefined,
    })
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => {
        throw new Error('child logger is not used here')
      },
    }

    expect(() =>
      writeCachedDatafile(SDK_KEY, { datafile: datafile(), etag: null }, logger),
    ).not.toThrow()
    expect(logger.debug).toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('touchCachedDatafile', () => {
  it('keeps the body and refreshes the timestamp and ETag after a 304', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now - 100_000)
    writeCachedDatafile(SDK_KEY, { datafile: datafile(), etag: 'old-etag' })

    vi.spyOn(Date, 'now').mockReturnValue(now)
    touchCachedDatafile(SDK_KEY, 'new-etag')

    const cached = readCachedDatafile(SDK_KEY)
    expect(cached?.etag).toBe('new-etag')
    expect(cached?.datafile.publishedAt).toBe('2026-01-01T00:00:00Z')
    expect(cached?.ageMs).toBe(0)
  })

  it('does nothing when there is no cached entry', () => {
    touchCachedDatafile(SDK_KEY, 'etag')
    expect(readCachedDatafile(SDK_KEY)).toBeNull()
  })
})

describe('clearCachedDatafile', () => {
  it('removes the entry', () => {
    writeCachedDatafile(SDK_KEY, { datafile: datafile(), etag: null })
    clearCachedDatafile(SDK_KEY)
    expect(readCachedDatafile(SDK_KEY)).toBeNull()
  })
})
