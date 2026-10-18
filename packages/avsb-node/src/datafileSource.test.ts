import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlagDatafile, Logger } from '@avsbhq/core'
import { fetchDatafile, sendHeartbeat } from './datafileSource'

const DATAFILE: FlagDatafile = {
  version: 2,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk_production_datafilesource1',
  environmentKey: 'production',
  publishedAt: '2026-05-28T00:00:00.000Z',
  collectEndpoint: 'https://collect.test.invalid',
  flags: [],
  audiences: [],
}

function makeLogger(): Logger & { errors: string[] } {
  const errors: string[] = []
  return {
    errors,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (message: string) => {
      errors.push(message)
    },
    child() {
      return this
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetchDatafile', () => {
  it('composes the URL through the core endpoint contract', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(DATAFILE), { status: 200 })
    )
    global.fetch = fetchMock

    await fetchDatafile({
      sdkKey: DATAFILE.sdkKey,
      signal: new AbortController().signal,
      logger: makeLogger(),
    })

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://cdn.avsb.cloud/${DATAFILE.sdkKey}/datafile.json`
    )
  })

  it('honours a custom cdnHost', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(DATAFILE), { status: 200 })
    )
    global.fetch = fetchMock

    await fetchDatafile({
      sdkKey: DATAFILE.sdkKey,
      cdnHost: 'https://cdn.example.com/',
      signal: new AbortController().signal,
      logger: makeLogger(),
    })

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://cdn.example.com/${DATAFILE.sdkKey}/datafile.json`
    )
  })

  it('returns the parsed datafile and its etag on 200', async () => {
    global.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(DATAFILE), {
        status: 200,
        headers: { etag: 'W/"abc"' },
      })
    )

    const outcome = await fetchDatafile({
      sdkKey: DATAFILE.sdkKey,
      signal: new AbortController().signal,
      logger: makeLogger(),
    })

    expect(outcome).toEqual({
      status: 'ok',
      datafile: DATAFILE,
      etag: 'W/"abc"',
    })
  })

  it('sends If-None-Match when an etag is held, and reports 304 as not-modified', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 304 }))
    global.fetch = fetchMock

    const outcome = await fetchDatafile({
      sdkKey: DATAFILE.sdkKey,
      signal: new AbortController().signal,
      logger: makeLogger(),
      etag: 'W/"abc"',
    })

    expect(outcome).toEqual({ status: 'not-modified' })
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['If-None-Match']).toBe('W/"abc"')
  })

  it('omits If-None-Match when nothing is held', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(DATAFILE), { status: 200 })
    )
    global.fetch = fetchMock

    await fetchDatafile({
      sdkKey: DATAFILE.sdkKey,
      signal: new AbortController().signal,
      logger: makeLogger(),
      etag: null,
    })

    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['If-None-Match']).toBeUndefined()
  })

  it('explains a 404 by naming the key, the URL, and where to look', async () => {
    global.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('not found', { status: 404 }))
    const logger = makeLogger()

    const outcome = await fetchDatafile({
      sdkKey: DATAFILE.sdkKey,
      signal: new AbortController().signal,
      logger,
    })

    expect(outcome).toEqual({ status: 'failed' })
    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]).toContain('404')
    expect(logger.errors[0]).toContain(DATAFILE.sdkKey)
    expect(logger.errors[0]).toContain('Environments')
  })

  it('distinguishes a network failure from a rejected key', async () => {
    global.fetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'))
    const logger = makeLogger()

    const outcome = await fetchDatafile({
      sdkKey: DATAFILE.sdkKey,
      signal: new AbortController().signal,
      logger,
    })

    expect(outcome).toEqual({ status: 'failed' })
    expect(logger.errors[0]).toContain('network, DNS, or TLS')
  })

  it('reports an aborted request as aborted and logs nothing', async () => {
    const controller = new AbortController()
    global.fetch = vi.fn<typeof fetch>().mockImplementation(() => {
      controller.abort()
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    })
    const logger = makeLogger()

    const outcome = await fetchDatafile({
      sdkKey: DATAFILE.sdkKey,
      signal: controller.signal,
      logger,
    })

    expect(outcome).toEqual({ status: 'aborted' })
    expect(logger.errors).toHaveLength(0)
  })
})

describe('sendHeartbeat', () => {
  it('posts {sdkKey, sdkType, sdkVersion} to the datafile endpoint', () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    global.fetch = fetchMock

    const endpoint = sendHeartbeat({
      sdkKey: DATAFILE.sdkKey,
      sdkType: '@avsbhq/node',
      sdkVersion: '1.6.2',
      datafileHeartbeatEndpoint: 'https://app.avsb.cloud/api/sdk/heartbeat',
      signal: new AbortController().signal,
    })

    expect(endpoint).toBe('https://app.avsb.cloud/api/sdk/heartbeat')
    const init = fetchMock.mock.calls[0][1]
    expect(init?.method).toBe('POST')
    // The exact wire shape the Environments page reads.
    expect(JSON.parse(String(init?.body))).toEqual({
      sdkKey: DATAFILE.sdkKey,
      sdkType: '@avsbhq/node',
      sdkVersion: '1.6.2',
    })
  })

  it('sends nothing when the datafile carries no heartbeat endpoint', () => {
    const fetchMock = vi.fn<typeof fetch>()
    global.fetch = fetchMock

    expect(
      sendHeartbeat({
        sdkKey: DATAFILE.sdkKey,
        sdkType: '@avsbhq/node',
        sdkVersion: '1.6.2',
        signal: new AbortController().signal,
      })
    ).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('swallows a failed heartbeat: liveness must never affect evaluation', () => {
    global.fetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))

    expect(() =>
      sendHeartbeat({
        sdkKey: DATAFILE.sdkKey,
        sdkType: '@avsbhq/node',
        sdkVersion: '1.6.2',
        datafileHeartbeatEndpoint: 'https://app.avsb.cloud/api/sdk/heartbeat',
        signal: new AbortController().signal,
      })
    ).not.toThrow()
  })
})
