import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getDatafile, DEFAULT_REVALIDATE_SECONDS } from './getDatafile'
import type { FlagDatafile } from '@avsbhq/core'

function makeDatafile(partial?: Partial<FlagDatafile>): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'sdk_production_getdatafile000',
    environmentKey: 'production',
    publishedAt: '2026-01-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.test.invalid',
    flags: [],
    audiences: [],
    ...partial,
  }
}

type FetchCall = [string, { signal?: AbortSignal; next?: { revalidate?: number } }]

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
}

function calls(): FetchCall[] {
  return (globalThis.fetch as unknown as { mock: { calls: FetchCall[] } }).mock.calls
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('getDatafile', () => {
  it('requests the contract URL, not the path that 404s', async () => {
    const datafile = makeDatafile()
    mockFetch({ ok: true, json: () => Promise.resolve(datafile) })

    const result = await getDatafile('sdk_production_abc123456789')

    expect(result).toEqual(datafile)
    // The old hand-built '/v1/datafile/<key>' path does not exist at the
    // edge. The canonical shape is '{cdnHost}/{sdkKey}/datafile.json'
    // (spec §1.1), and it comes from @avsbhq/core so there is one copy.
    expect(calls()[0][0]).toBe(
      'https://cdn.avsb.cloud/sdk_production_abc123456789/datafile.json',
    )
  })

  it('honours a custom cdnHost and trims its trailing slash', async () => {
    mockFetch({ ok: true, json: () => Promise.resolve(makeDatafile()) })

    await getDatafile('sdk_production_abc123456789', { cdnHost: 'https://cdn.example.com/' })

    expect(calls()[0][0]).toBe(
      'https://cdn.example.com/sdk_production_abc123456789/datafile.json',
    )
  })

  it('asks Next to revalidate on the default window', async () => {
    mockFetch({ ok: true, json: () => Promise.resolve(makeDatafile()) })

    await getDatafile('sdk_production_abc123456789')

    expect(calls()[0][1].next).toEqual({ revalidate: DEFAULT_REVALIDATE_SECONDS })
  })

  it('passes a caller-supplied revalidate window through', async () => {
    mockFetch({ ok: true, json: () => Promise.resolve(makeDatafile()) })

    await getDatafile('sdk_production_abc123456789', { revalidate: 0 })

    expect(calls()[0][1].next).toEqual({ revalidate: 0 })
  })

  it('uses a caller-supplied signal instead of its own timeout', async () => {
    mockFetch({ ok: true, json: () => Promise.resolve(makeDatafile()) })
    const controller = new AbortController()

    await getDatafile('sdk_production_abc123456789', { signal: controller.signal })

    expect(calls()[0][1].signal).toBe(controller.signal)
  })

  it('names the status, the URL, and the fix when the response is not 2xx', async () => {
    mockFetch({ ok: false, status: 404, statusText: 'Not Found' })

    await expect(getDatafile('sdk_production_missing00000')).rejects.toThrow(
      /404 Not Found for https:\/\/cdn\.avsb\.cloud\/sdk_production_missing00000\/datafile\.json/,
    )
    await expect(getDatafile('sdk_production_missing00000')).rejects.toThrow(
      /Environments in the project sidebar/,
    )
  })

  it('refuses an empty key rather than composing a URL that cannot work', async () => {
    mockFetch({ ok: true, json: () => Promise.resolve(makeDatafile()) })

    await expect(getDatafile('')).rejects.toThrow(/without an SDK key/)
  })
})
