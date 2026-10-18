import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchDatafile } from './server'
import type { FlagDatafile } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDatafile(
  overrides?: Partial<FlagDatafile>
): FlagDatafile {
  return {
    version: 1,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'sdk_server_test',
    environmentKey: 'production',
    publishedAt: '2025-01-01T00:00:00Z',
    collectEndpoint: 'http://localhost:3001',
    flags: [],
    audiences: [],
    ...overrides,
  }
}

// vi.stubGlobal DEFINES the property instead of assigning to it, so it works
// whatever shape the environment gives `fetch` (data property, settable
// accessor, or getter-only accessor). vi.unstubAllGlobals() restores the
// original descriptor, so no manual save/restore is needed.
function setGlobalFetch(mock: typeof globalThis.fetch): void {
  vi.stubGlobal('fetch', mock)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchDatafile', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('returns parsed FlagDatafile on successful response', async () => {
    const mockData = createMockDatafile({ sdkKey: 'sdk_success' })

    setGlobalFetch(vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData),
    }))

    const result = await fetchDatafile('sdk_success')
    expect(result).toEqual(mockData)
    expect(result?.sdkKey).toBe('sdk_success')
  })

  it('returns null on 404 response', async () => {
    setGlobalFetch(vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }))

    const result = await fetchDatafile('sdk_nonexistent')
    expect(result).toBeNull()
  })

  it('returns null on network error', async () => {
    setGlobalFetch(vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const result = await fetchDatafile('sdk_error')
    expect(result).toBeNull()
  })

  it('uses custom cdnHost when provided', async () => {
    const mockData = createMockDatafile()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData),
    })
    setGlobalFetch(fetchMock)

    await fetchDatafile('sdk_custom_host', {
      cdnHost: 'https://custom-cdn.example.com',
    })

    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toBe(
      'https://custom-cdn.example.com/sdk_custom_host/datafile.json'
    )
  })

  it('uses default CDN host when no cdnHost provided', async () => {
    const mockData = createMockDatafile()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData),
    })
    setGlobalFetch(fetchMock)

    await fetchDatafile('sdk_default_host')

    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toMatch(/^https:\/\/cdn\.avsb\.cloud\//)
    expect(calledUrl).toBe(
      'https://cdn.avsb.cloud/sdk_default_host/datafile.json'
    )
  })

  it('strips a trailing slash from a custom cdnHost', async () => {
    const mockData = createMockDatafile()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockData),
    })
    setGlobalFetch(fetchMock)

    await fetchDatafile('sdk_slash_host', {
      cdnHost: 'https://custom-cdn.example.com/',
    })

    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toBe(
      'https://custom-cdn.example.com/sdk_slash_host/datafile.json'
    )
  })

  it('aborts after timeout', async () => {
    vi.useFakeTimers()

    // Simulate a fetch that never resolves until aborted.
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, options?: RequestInit) =>
        new Promise((_resolve, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted', 'AbortError'))
            })
          }
        })
    )
    setGlobalFetch(fetchMock)

    const resultPromise = fetchDatafile('sdk_timeout', { timeout: 100 })

    await vi.advanceTimersByTimeAsync(150)

    const result = await resultPromise
    expect(result).toBeNull()

    vi.useRealTimers()
  })
})
