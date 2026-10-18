import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlagDatafile } from '@avsbhq/core'
import { datafileRequestUrl, fetchDatafileConditional } from './datafileFetch'
import { AvsbNetworkError, AvsbTimeoutError } from './net'

const SDK_KEY = 'sdk_production_transport000000000000'

function datafile(): FlagDatafile {
  return {
    version: 1,
    projectType: 'FEATURE_FLAG',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
    publishedAt: '2026-01-01T00:00:00Z',
    collectEndpoint: 'https://collect.test.invalid',
    flags: [],
    audiences: [],
  }
}

interface Answer {
  status?: number
  etag?: string | null
  body?: unknown
  throws?: Error
  never?: boolean
}

function mockFetch(answer: Answer): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
    if (answer.never) return new Promise(() => undefined)
    if (answer.throws) return Promise.reject(answer.throws)
    const status = answer.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'etag' ? answer.etag ?? null : null,
      },
      json: () => Promise.resolve(answer.body ?? datafile()),
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('datafileRequestUrl', () => {
  it('builds the canonical CDN path', () => {
    expect(datafileRequestUrl(SDK_KEY, 'https://cdn.avsb.cloud')).toBe(
      `https://cdn.avsb.cloud/${SDK_KEY}/datafile.json`,
    )
  })

  it('honours a custom host and trims a trailing slash', () => {
    expect(datafileRequestUrl(SDK_KEY, 'https://cdn.example.com/')).toBe(
      `https://cdn.example.com/${SDK_KEY}/datafile.json`,
    )
  })

  it('returns a printable URL for an empty key instead of throwing', () => {
    // The key-shape check has already reported this; error messages still
    // need something to print.
    expect(datafileRequestUrl('', 'https://cdn.avsb.cloud')).toBe(
      'https://cdn.avsb.cloud//datafile.json',
    )
  })
})

describe('fetchDatafileConditional', () => {
  it('returns the parsed datafile and its ETag on a 200', async () => {
    mockFetch({ status: 200, etag: 'W/"v2"' })

    const outcome = await fetchDatafileConditional({
      sdkKey: SDK_KEY,
      cdnHost: 'https://cdn.avsb.cloud',
      timeoutMs: 1000,
    })

    expect(outcome).toEqual({
      kind: 'datafile',
      datafile: datafile(),
      etag: 'W/"v2"',
    })
  })

  it('sends If-None-Match only when an ETag is held', async () => {
    const withEtag = mockFetch({ status: 304, etag: 'v1' })
    await fetchDatafileConditional({
      sdkKey: SDK_KEY,
      cdnHost: 'https://cdn.avsb.cloud',
      etag: 'v1',
      timeoutMs: 1000,
    })
    const sent = (withEtag.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(sent['If-None-Match']).toBe('v1')

    const withoutEtag = mockFetch({ status: 200 })
    await fetchDatafileConditional({
      sdkKey: SDK_KEY,
      cdnHost: 'https://cdn.avsb.cloud',
      timeoutMs: 1000,
    })
    const init = withoutEtag.mock.calls[0][1] as RequestInit
    expect(init.headers).toBeUndefined()
  })

  it('reports a 304 as notModified, carrying the ETag forward', async () => {
    mockFetch({ status: 304, etag: 'v1' })

    const outcome = await fetchDatafileConditional({
      sdkKey: SDK_KEY,
      cdnHost: 'https://cdn.avsb.cloud',
      etag: 'v1',
      timeoutMs: 1000,
    })

    expect(outcome).toEqual({ kind: 'notModified', etag: 'v1' })
  })

  it('reports a non-2xx as data, with the status and the URL tried', async () => {
    mockFetch({ status: 404 })

    const outcome = await fetchDatafileConditional({
      sdkKey: SDK_KEY,
      cdnHost: 'https://cdn.avsb.cloud',
      timeoutMs: 1000,
    })

    expect(outcome).toEqual({
      kind: 'httpError',
      status: 404,
      url: `https://cdn.avsb.cloud/${SDK_KEY}/datafile.json`,
    })
  })

  it('throws a network error naming the host and the likely causes', async () => {
    mockFetch({ throws: new TypeError('Failed to fetch') })

    await expect(
      fetchDatafileConditional({
        sdkKey: SDK_KEY,
        cdnHost: 'https://cdn.avsb.cloud',
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(AvsbNetworkError)

    mockFetch({ throws: new TypeError('Failed to fetch') })
    await expect(
      fetchDatafileConditional({
        sdkKey: SDK_KEY,
        cdnHost: 'https://cdn.avsb.cloud',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/cdn\.avsb\.cloud.*Content Security Policy/s)
  })

  it('names the host and the URL when a 200 body is not valid JSON', async () => {
    // A proxy error page, a captive portal, or a blocking extension answering
    // for the CDN. This used to surface a bare SyntaxError with no URL in it.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
        }),
      ),
    )

    await expect(
      fetchDatafileConditional({
        sdkKey: SDK_KEY,
        cdnHost: 'https://cdn.avsb.cloud',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/cdn\.avsb\.cloud[\s\S]*datafile\.json[\s\S]*JSON/)
  })

  it('aborts and throws a timeout error when the host stalls', async () => {
    vi.useFakeTimers()
    try {
      const aborted = vi.fn()
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                aborted()
                reject(new DOMException('The operation was aborted', 'AbortError'))
              })
            }),
        ),
      )

      const pending = fetchDatafileConditional({
        sdkKey: SDK_KEY,
        cdnHost: 'https://cdn.avsb.cloud',
        timeoutMs: 250,
      })
      const assertion = expect(pending).rejects.toBeInstanceOf(AvsbTimeoutError)
      await vi.advanceTimersByTimeAsync(300)
      await assertion

      expect(aborted).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
