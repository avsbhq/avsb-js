// =====================================================================
// AvsbEdgeClient — init, readiness, and loudness (spec §1.2, B1, B15).
//
// Flag reading lives in AvsbEdgeClient.flags.test.ts and event delivery in
// AvsbEdgeClient.events.test.ts.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AvsbEdgeClient } from './AvsbEdgeClient'
import { resetLogOnce } from './logger'
import {
  VALID_SDK_KEY,
  cachedAgo,
  captureLogger,
  jsonResponse,
  makeStorage,
  testDatafile,
} from './fixtures'

beforeEach(() => {
  resetLogOnce()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(testDatafile)))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------
// InitResult semantics (B1 + spec §1.2)
// ---------------------------------------------------------------------

describe('AvsbEdgeClient.init — result semantics', () => {
  it('reports success from bootstrap without touching the network', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      logLevel: 'silent',
    })

    expect(await client.init()).toEqual({ success: true, source: 'bootstrap' })
    expect(mockFetch).not.toHaveBeenCalled()
    expect(client.isReady()).toBe(true)
  })

  it('reports success from the network on a 200', async () => {
    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logLevel: 'silent' })

    expect(await client.init()).toEqual({ success: true, source: 'network' })
    expect(client.getDatafile()?.sdkKey).toBe(VALID_SDK_KEY)
  })

  it('reports success: false with no datafile and no fallback (B1)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 404 })))
    const logger = captureLogger()

    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logger })
    const result = await client.init()

    // This used to be a silent success with every flag on its default value.
    expect(result.success).toBe(false)
    expect(result.source).toBe('error')
    expect(result.degraded).toBeUndefined()
    expect(client.isReady()).toBe(false)
    expect(logger.said('HTTP 404')).toBe(true)
  })

  it('reserves degraded for a stale cache served after a failed refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const logger = captureLogger()

    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      storage: makeStorage({
        datafileGet: vi.fn().mockResolvedValue(cachedAgo(10 * 60 * 1000)),
      }),
      cacheTtlMs: 60_000,
      logger,
    })
    const result = await client.init()

    expect(result).toMatchObject({ success: true, degraded: true, source: 'error' })
    expect(client.isReady()).toBe(true)
    expect(logger.said('serving the cached copy from 600s ago')).toBe(true)
  })

  it('does not set degraded when the cache is still fresh', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      storage: makeStorage({ datafileGet: vi.fn().mockResolvedValue(cachedAgo(1000)) }),
      cacheTtlMs: 300_000,
      logLevel: 'silent',
    })
    const result = await client.init()

    expect(result).toEqual({ success: true, source: 'bootstrap' })
    expect(result.degraded).toBeUndefined()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('exposes the settled result through getInitResult', async () => {
    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logLevel: 'silent' })

    expect(client.getInitResult()).toBeNull()
    await client.init()
    expect(client.getInitResult()).toEqual({ success: true, source: 'network' })
  })
})

// ---------------------------------------------------------------------
// Cache freshness
// ---------------------------------------------------------------------

describe('AvsbEdgeClient.init — cache freshness', () => {
  it('revalidates over the network once the cached copy is past cacheTtlMs', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(testDatafile))
    vi.stubGlobal('fetch', mockFetch)

    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      storage: makeStorage({ datafileGet: vi.fn().mockResolvedValue(cachedAgo(10_000)) }),
      cacheTtlMs: 5_000,
      logLevel: 'silent',
    })

    expect(await client.init()).toEqual({ success: true, source: 'network' })
    expect(mockFetch).toHaveBeenCalled()
  })

  it('treats cacheTtlMs of 0 as always revalidate', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(testDatafile))
    vi.stubGlobal('fetch', mockFetch)

    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      storage: makeStorage({ datafileGet: vi.fn().mockResolvedValue(cachedAgo(0)) }),
      cacheTtlMs: 0,
      logLevel: 'silent',
    })
    await client.init()

    expect(mockFetch).toHaveBeenCalled()
  })

  it('writes a freshly fetched datafile back to storage through waitUntil', async () => {
    const storage = makeStorage()
    const waitUntil = vi.fn()

    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      storage,
      waitUntil,
      logLevel: 'silent',
      heartbeat: false,
    })
    await client.init()

    expect(storage.datafileSet).toHaveBeenCalledWith(VALID_SDK_KEY, testDatafile)
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise))
  })

  it('survives a storage read that throws and reports it as a cache error', async () => {
    const onError = vi.fn()
    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      storage: makeStorage({ datafileGet: vi.fn().mockRejectedValue(new Error('KV 503')) }),
      logLevel: 'silent',
      onError,
    })

    // A broken cache must never take the request down.
    expect(await client.init()).toEqual({ success: true, source: 'network' })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'KV 503' }), 'cache')
  })
})

// ---------------------------------------------------------------------
// Idempotency and the custom fetcher
// ---------------------------------------------------------------------

describe('AvsbEdgeClient.init — idempotency', () => {
  /**
   * DATAFILE requests only. A successful init also reports liveness to the
   * heartbeat endpoint the datafile publishes, so counting every call would
   * make these cases fail for a request that has nothing to do with datafile
   * fetching (and the heartbeat has its own case below).
   */
  function datafileCalls(mockFetch: ReturnType<typeof vi.fn>): unknown[] {
    return mockFetch.mock.calls.filter((call) =>
      String((call as [string])[0]).includes('/datafile.json'),
    )
  }

  it('fetches once for concurrent callers', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(testDatafile))
    vi.stubGlobal('fetch', mockFetch)

    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logLevel: 'silent' })
    const [a, b] = await Promise.all([client.init(), client.init()])

    expect(datafileCalls(mockFetch)).toHaveLength(1)
    expect(a).toEqual(b)
  })

  it('returns the first result on a later call without re-fetching', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(testDatafile))
    vi.stubGlobal('fetch', mockFetch)

    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logLevel: 'silent' })
    await client.init()
    await client.init()

    expect(datafileCalls(mockFetch)).toHaveLength(1)
  })

  it('uses a supplied fetchDatafile instead of the CDN', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    const fetchDatafile = vi.fn().mockResolvedValue(testDatafile)

    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      fetchDatafile,
      logLevel: 'silent',
    })

    expect(await client.init()).toEqual({ success: true, source: 'network' })
    expect(fetchDatafile).toHaveBeenCalledWith(VALID_SDK_KEY)
    // The CDN is never dialled FOR THE DATAFILE. Liveness still rides the
    // datafile's own heartbeat endpoint, which is a different request.
    expect(datafileCalls(mockFetch)).toHaveLength(0)
  })

  it('treats a fetchDatafile returning null as a failed init, naming the URL', async () => {
    const logger = captureLogger()
    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      fetchDatafile: vi.fn().mockResolvedValue(null),
      logger,
    })

    expect((await client.init()).success).toBe(false)
    expect(logger.said(`${VALID_SDK_KEY}/datafile.json`)).toBe(true)
  })

  it('treats a fetchDatafile that throws as a failed init and never rejects', async () => {
    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      fetchDatafile: vi.fn().mockRejectedValue(new Error('boom')),
      logLevel: 'silent',
    })

    const result = await client.init()
    expect(result.success).toBe(false)
    expect(result.error?.message).toBe('boom')
  })
})

// ---------------------------------------------------------------------
// Heartbeat (wire fixture `heartbeat`)
// ---------------------------------------------------------------------

describe('AvsbEdgeClient heartbeat', () => {
  it('posts {sdkKey, sdkType, sdkVersion} to the datafile heartbeat endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(testDatafile))
    vi.stubGlobal('fetch', mockFetch)

    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logLevel: 'silent' })
    await client.init()
    await client.flushEvents()

    const heartbeat = mockFetch.mock.calls.find((call) =>
      String((call as [string])[0]).includes('/api/sdk/heartbeat'),
    ) as [string, RequestInit] | undefined

    expect(heartbeat).toBeDefined()
    expect(heartbeat?.[0]).toBe('https://app.test.invalid/api/sdk/heartbeat')
    expect(JSON.parse(String(heartbeat?.[1].body))).toEqual({
      sdkKey: VALID_SDK_KEY,
      sdkType: '@avsbhq/edge',
      sdkVersion: expect.any(String),
    })
  })

  it('sends no heartbeat when the datafile publishes no endpoint', async () => {
    const noHeartbeat = { ...testDatafile, heartbeatEndpoint: undefined }
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(noHeartbeat))
    vi.stubGlobal('fetch', mockFetch)

    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logLevel: 'silent' })
    await client.init()
    await client.flushEvents()

    // Never guessed: a heartbeat to the wrong host reports liveness nowhere
    // while looking healthy.
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('sends no heartbeat when serving from cache, only after a real fetch', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      storage: makeStorage({ datafileGet: vi.fn().mockResolvedValue(cachedAgo(1000)) }),
      logLevel: 'silent',
    })
    await client.init()
    await client.flushEvents()

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('can be turned off', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(testDatafile))
    vi.stubGlobal('fetch', mockFetch)

    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      heartbeat: false,
      logLevel: 'silent',
    })
    await client.init()
    await client.flushEvents()

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('never fails the request when the heartbeat host is unreachable', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(testDatafile))
      .mockRejectedValue(new Error('heartbeat host down'))
    vi.stubGlobal('fetch', mockFetch)

    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logLevel: 'silent' })
    await client.init()

    await expect(client.flushEvents()).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------
// Construction-time loudness
// ---------------------------------------------------------------------

describe('AvsbEdgeClient construction', () => {
  it('reports a key that does not look like an SDK key, and keeps going', async () => {
    const logger = captureLogger()

    const client = new AvsbEdgeClient({ sdkKey: 'sdk-prod-xxx', logger })

    const message = logger.messages('error').join('\n')
    expect(message).toContain('sdk-prod-xxx')
    expect(message).toContain('has never existed in A vs B')
    expect(message).toContain('Environments')
    // Proceeds regardless: the datafile request is the real arbiter.
    expect(await client.init()).toMatchObject({ success: true })
  })

  it('reports the same bad key only once per isolate', () => {
    const logger = captureLogger()

    new AvsbEdgeClient({ sdkKey: 'not-a-key', logger })
    new AvsbEdgeClient({ sdkKey: 'not-a-key', logger })
    new AvsbEdgeClient({ sdkKey: 'not-a-key', logger })

    // Edge clients are per request, so without isolate-scoped dedupe a busy
    // Worker would print this on every request.
    expect(logger.messages('error')).toHaveLength(1)
  })

  it('says nothing about a well-shaped key', () => {
    const logger = captureLogger()

    new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logger })

    expect(logger.messages('error')).toHaveLength(0)
  })

  it('warns when a bootstrap datafile belongs to another environment', () => {
    const logger = captureLogger()

    new AvsbEdgeClient({
      sdkKey: 'sdk_development_aaaaaaaaaaaaaaaaaaaaaaaa',
      datafile: testDatafile,
      logger,
    })

    const warning = logger.messages('warn').join('\n')
    expect(warning).toContain('sdk_development_aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(warning).toContain(VALID_SDK_KEY)
    expect(warning).toContain('wrong environment')
  })
})
