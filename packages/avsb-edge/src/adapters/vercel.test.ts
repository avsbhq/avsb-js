// =====================================================================
// adapters/vercel.ts — contextFrom extraction from the x-vercel-ip-* headers,
// and the Edge Config storage TTL (report 02 §5.13).
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EvalContext } from '@avsbhq/core'
import {
  createEdgeConfigAdapter,
  createVercelHandler,
  vercelContextFrom,
  vercelGeo,
} from './vercel'
import { resetLogOnce } from '../logger'
import {
  VALID_SDK_KEY,
  VISITOR_HEADER,
  jsonResponse,
  requestWith,
  testDatafile,
} from '../fixtures'

beforeEach(() => {
  resetLogOnce()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(testDatafile)))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------
// contextFrom
// ---------------------------------------------------------------------

describe('vercelGeo', () => {
  it('reads the x-vercel-ip-* headers', () => {
    const req = requestWith({
      'x-vercel-ip-country': 'US',
      'x-vercel-ip-country-region': 'CA',
      'x-vercel-ip-city': 'San%20Francisco',
      'x-vercel-ip-timezone': 'America/Los_Angeles',
      'x-vercel-ip-latitude': '37.7749',
      'x-vercel-ip-longitude': '-122.4194',
    })

    expect(vercelGeo(req)).toEqual({
      country: 'US',
      region: 'CA',
      // Vercel percent-encodes city names, so a raw read gives "San%20Francisco".
      city: 'San Francisco',
      timezone: 'America/Los_Angeles',
      latitude: 37.7749,
      longitude: -122.4194,
    })
  })

  it('reports nothing for a request Vercel did not annotate', () => {
    const geo = vercelGeo(requestWith({}))

    expect(Object.values(geo).every((v) => v === undefined)).toBe(true)
  })

  it('keeps a city value that cannot be decoded rather than dropping it', () => {
    expect(vercelGeo(requestWith({ 'x-vercel-ip-city': '100%' })).city).toBe('100%')
  })
})

describe('vercelContextFrom', () => {
  it('extracts identity, geo, and page attributes', () => {
    const req = requestWith(
      { [VISITOR_HEADER]: 'v_abc', 'x-vercel-ip-country': 'US' },
      'https://shop.example.com/pricing',
    )

    expect(vercelContextFrom(req)).toEqual({
      kind: 'user',
      key: 'v_abc',
      url: 'https://shop.example.com/pricing',
      path: '/pricing',
      host: 'shop.example.com',
      country: 'US',
    })
  })

  it('never uses x-real-ip as the bucketing key', () => {
    expect(vercelContextFrom(requestWith({ 'x-real-ip': '203.0.113.7' })).key).toBe('')
  })
})

// ---------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------

describe('createVercelHandler', () => {
  it('binds the extracted context so the handler needs no context argument', async () => {
    let value: string | undefined

    const handler = createVercelHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        value = client.getStringFlag('theme', 'light').value
        return Response.json({ ok: true })
      },
    })

    const res = await handler(requestWith({ [VISITOR_HEADER]: 'v_abc' }))

    expect(res.status).toBe(200)
    expect(value).toBe('midnight')
  })

  it('calls a supplied contextFrom instead of the default', async () => {
    const contextFrom = vi.fn((): EvalContext => ({ kind: 'user', key: 'custom' }))
    let bound: EvalContext | undefined

    const handler = createVercelHandler({
      sdkKey: VALID_SDK_KEY,
      contextFrom,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        bound = client.getContext()
        return new Response('ok')
      },
    })
    await handler(requestWith({}))

    // The option used to be declared and never called on every adapter.
    expect(contextFrom).toHaveBeenCalledTimes(1)
    expect(bound).toEqual({ kind: 'user', key: 'custom' })
  })

  it('defers the flush to waitUntil when a FetchEvent is passed', async () => {
    const ctx = { waitUntil: vi.fn() }

    const handler = createVercelHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async () => new Response('ok'),
    })
    await handler(requestWith({}), ctx)

    expect(ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise))
  })

  it('awaits the flush when there is no FetchEvent, so events are not dropped', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }))
    vi.stubGlobal('fetch', mockFetch)

    const handler = createVercelHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        client.getFlag('checkout-v2', false)
        return new Response('ok')
      },
    })
    await handler(requestWith({ [VISITOR_HEADER]: 'v_abc' }))

    // The old adapter used `.catch(() => undefined)` here, so a plain route
    // handler silently discarded every batch.
    expect(
      mockFetch.mock.calls.some(([url]) => String(url).includes('/v1/collect/batch')),
    ).toBe(true)
  })

  it('shares one in-process cache across requests to the same handler', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(testDatafile))
    vi.stubGlobal('fetch', mockFetch)

    const handler = createVercelHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { logLevel: 'silent', heartbeat: false },
      handler: async () => new Response('ok'),
    })

    await handler(requestWith({}))
    await handler(requestWith({}))

    // Two requests, one datafile fetch: the storage adapter is built once per
    // handler, not once per request.
    const datafileFetches = mockFetch.mock.calls.filter(([url]) =>
      String(url).includes('/datafile.json'),
    )
    expect(datafileFetches).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------
// Edge Config storage
// ---------------------------------------------------------------------

describe('createEdgeConfigAdapter', () => {
  it('serves a written datafile back from memory', async () => {
    const storage = createEdgeConfigAdapter()

    await storage.datafileSet(VALID_SDK_KEY, testDatafile)

    expect((await storage.datafileGet(VALID_SDK_KEY))?.datafile.sdkKey).toBe(VALID_SDK_KEY)
  })

  it('expires the in-memory copy past the retention bound', async () => {
    vi.useFakeTimers()
    const storage = createEdgeConfigAdapter(undefined, 1000)

    await storage.datafileSet(VALID_SDK_KEY, testDatafile)
    vi.advanceTimersByTime(1001)

    // The bug this closes: the map had NO expiry, so a warm isolate served one
    // datafile forever no matter what was published.
    expect(await storage.datafileGet(VALID_SDK_KEY)).toBeNull()
  })

  it('reads a JSON string from Edge Config and warms the memory copy', async () => {
    // The clock is pinned to the stored `cachedAt`, because the memory copy
    // inherits that timestamp rather than the moment it was read: against the
    // real clock the entry is already older than the retention bound and the
    // second read would go back to Edge Config, which is the opposite of what
    // this test is about.
    vi.useFakeTimers()
    vi.setSystemTime(1780000000000)
    const get = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ datafile: testDatafile, cachedAt: 1780000000000 }))
    const storage = createEdgeConfigAdapter({ get })

    const first = await storage.datafileGet(VALID_SDK_KEY)
    const second = await storage.datafileGet(VALID_SDK_KEY)

    expect(get).toHaveBeenCalledWith(`avsb_df_${VALID_SDK_KEY}`)
    expect(get).toHaveBeenCalledTimes(1)
    expect(first?.cachedAt).toBe(1780000000000)
    expect(second?.datafile.sdkKey).toBe(VALID_SDK_KEY)
  })

  it('reads an already-parsed Edge Config object too', async () => {
    const storage = createEdgeConfigAdapter({
      get: vi.fn().mockResolvedValue({ datafile: testDatafile, cachedAt: 1780000000000 }),
    })

    expect((await storage.datafileGet(VALID_SDK_KEY))?.datafile.sdkKey).toBe(VALID_SDK_KEY)
  })

  it('treats a value with no datafile as a miss', async () => {
    const storage = createEdgeConfigAdapter({ get: vi.fn().mockResolvedValue({ other: 1 }) })

    expect(await storage.datafileGet(VALID_SDK_KEY)).toBeNull()
  })

  it('stamps a missing cachedAt as now rather than epoch zero', async () => {
    const storage = createEdgeConfigAdapter({
      get: vi.fn().mockResolvedValue({ datafile: testDatafile }),
    })

    const entry = await storage.datafileGet(VALID_SDK_KEY)

    // Epoch zero would make a hand-populated Edge Config value permanently
    // stale, so it would never be served.
    expect(entry?.cachedAt).toBeGreaterThan(1_700_000_000_000)
  })

  it('survives an Edge Config outage by reporting a miss', async () => {
    const storage = createEdgeConfigAdapter({
      get: vi.fn().mockRejectedValue(new Error('edge config unavailable')),
    })

    await expect(storage.datafileGet(VALID_SDK_KEY)).resolves.toBeNull()
  })
})
