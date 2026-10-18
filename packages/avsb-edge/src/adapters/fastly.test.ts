// @vitest-environment node
//
// The edge SDK runs on servers, never in a browser. The default DOM test
// environment implements the Fetch spec's forbidden request headers, so a
// `Cookie` set through `new Request(url, { headers })` is silently dropped and
// the visitor a real request carries disappears; its `Headers` iterator also
// keeps the original header-name casing. Node reproduces what these platforms
// actually hand the adapter.
// =====================================================================
// adapters/fastly.ts — contextFrom extraction from event.client.geo, the
// lazily constructed KV Store, and the awaited flush.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EvalContext } from '@avsbhq/core'
import {
  createFastlyHandler,
  createFastlyKVAdapter,
  fastlyContextFrom,
  fastlyGeo,
  type FastlyFetchEvent,
  type FastlyKVStore,
} from './fastly'
import { resetLogOnce } from '../logger'
import {
  VALID_SDK_KEY,
  VISITOR_HEADER,
  jsonResponse,
  requestWith,
  snippetCookie,
  testDatafile,
} from '../fixtures'

function event(
  headers: Record<string, string> = {},
  client?: FastlyFetchEvent['client'],
): FastlyFetchEvent {
  return { request: requestWith(headers), client }
}

beforeEach(() => {
  resetLogOnce()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(testDatafile)))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------
// contextFrom
// ---------------------------------------------------------------------

describe('fastlyGeo', () => {
  it('maps Fastly snake_case geolocation onto the shared attribute names', () => {
    expect(
      fastlyGeo({
        geo: {
          country_code: 'JP',
          region: '13',
          city: 'Tokyo',
          continent: 'AS',
          postal_code: '100-0001',
          latitude: 35.6895,
          longitude: 139.6917,
        },
      }),
    ).toEqual({
      // An audience authored on `country` has to match here the same way it
      // does on Cloudflare, which is what this mapping is for.
      country: 'JP',
      region: '13',
      city: 'Tokyo',
      continent: 'AS',
      postalCode: '100-0001',
      latitude: 35.6895,
      longitude: 139.6917,
    })
  })

  it('returns nothing when the runtime exposes no client geo', () => {
    expect(fastlyGeo(undefined)).toEqual({})
    expect(fastlyGeo({ address: '203.0.113.7' })).toEqual({})
  })

  it('drops a non-finite latitude', () => {
    expect(fastlyGeo({ geo: { latitude: Number.NaN } }).latitude).toBeUndefined()
  })
})

describe('fastlyContextFrom', () => {
  it('extracts identity, geo, and page attributes from the fetch event', () => {
    const ctx = fastlyContextFrom(
      event({ [VISITOR_HEADER]: 'v_abc' }, { geo: { country_code: 'JP' } }),
    )

    expect(ctx).toEqual({
      kind: 'user',
      key: 'v_abc',
      url: 'https://shop.example.com/checkout?step=2',
      path: '/checkout',
      host: 'shop.example.com',
      country: 'JP',
    })
  })

  it('adopts the snippet cookie when no header is present', () => {
    const ctx = fastlyContextFrom(event({ cookie: `_avsb_visitor=${snippetCookie('v_snip')}` }))

    expect(ctx.key).toBe('v_snip')
  })

  it('never uses event.client.address as the bucketing key', () => {
    expect(fastlyContextFrom(event({}, { address: '203.0.113.7' })).key).toBe('')
  })
})

// ---------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------

describe('createFastlyHandler', () => {
  it('binds the extracted context so the handler needs no context argument', async () => {
    let value: boolean | undefined

    const handler = createFastlyHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        value = client.getBoolFlag('always-on', false).value
        return new Response('ok')
      },
    })
    await handler(event({ [VISITOR_HEADER]: 'v_abc' }))

    expect(value).toBe(true)
  })

  it('calls a supplied contextFrom with the whole event', async () => {
    const contextFrom = vi.fn(
      (e: FastlyFetchEvent): EvalContext => ({
        kind: 'user',
        key: e.client?.address ?? 'none',
      }),
    )
    let bound: EvalContext | undefined

    const handler = createFastlyHandler({
      sdkKey: VALID_SDK_KEY,
      contextFrom,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        bound = client.getContext()
        return new Response('ok')
      },
    })
    await handler(event({}, { address: '203.0.113.7' }))

    // Taking the whole event is what makes geo and the client address
    // reachable at all; the old signature took only the request.
    expect(contextFrom).toHaveBeenCalledTimes(1)
    expect(bound).toEqual({ kind: 'user', key: '203.0.113.7' })
  })

  it('constructs the KV Store through the thunk, inside the request', async () => {
    const kv: FastlyKVStore = {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    }
    const build = vi.fn(() => kv)

    const handler = createFastlyHandler({
      sdkKey: VALID_SDK_KEY,
      kvStore: build,
      clientOptions: { logLevel: 'silent', heartbeat: false },
      handler: async () => new Response('ok'),
    })

    // Not called while building the handler: Fastly forbids creating platform
    // resources during global initialisation.
    expect(build).not.toHaveBeenCalled()

    await handler(event({}))
    expect(build).toHaveBeenCalledTimes(1)
    expect(kv.get).toHaveBeenCalledWith(`avsb_df_${VALID_SDK_KEY}`)
  })

  it('awaits the flush, because Fastly has no waitUntil', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }))
    vi.stubGlobal('fetch', mockFetch)

    const handler = createFastlyHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        client.getFlag('checkout-v2', false)
        return new Response('ok')
      },
    })
    await handler(event({ [VISITOR_HEADER]: 'v_abc' }))

    expect(
      mockFetch.mock.calls.some(([url]) => String(url).includes('/v1/collect/batch')),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------
// KV Store storage
// ---------------------------------------------------------------------

describe('createFastlyKVAdapter', () => {
  it('round-trips a datafile through text()', async () => {
    const store = new Map<string, string>()
    const kv: FastlyKVStore = {
      get: vi.fn((key: string) => {
        const raw = store.get(key)
        return Promise.resolve(raw === undefined ? null : { text: () => Promise.resolve(raw) })
      }),
      put: vi.fn((key: string, value: string) => {
        store.set(key, value)
        return Promise.resolve(undefined)
      }),
    }
    const storage = createFastlyKVAdapter(kv)

    await storage.datafileSet(VALID_SDK_KEY, testDatafile)

    expect((await storage.datafileGet(VALID_SDK_KEY))?.datafile.sdkKey).toBe(VALID_SDK_KEY)
  })

  it('falls back to draining entry.body when there is no text()', async () => {
    const blob = JSON.stringify({ datafile: testDatafile, cachedAt: 1780000000000 })
    const kv: FastlyKVStore = {
      get: vi.fn().mockResolvedValue({
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(blob))
            controller.close()
          },
        }),
      }),
      put: vi.fn(),
    }

    const entry = await createFastlyKVAdapter(kv).datafileGet(VALID_SDK_KEY)

    expect(entry?.cachedAt).toBe(1780000000000)
  })

  it('reports a miss for an absent key and for an unreadable entry', async () => {
    const missing = createFastlyKVAdapter({
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
    })
    const unreadable = createFastlyKVAdapter({
      get: vi.fn().mockResolvedValue({}),
      put: vi.fn(),
    })

    expect(await missing.datafileGet(VALID_SDK_KEY)).toBeNull()
    expect(await unreadable.datafileGet(VALID_SDK_KEY)).toBeNull()
  })

  it('reports a miss when the stored value is not JSON', async () => {
    const kv: FastlyKVStore = {
      get: vi.fn().mockResolvedValue({ text: () => Promise.resolve('{not json') }),
      put: vi.fn(),
    }

    await expect(createFastlyKVAdapter(kv).datafileGet(VALID_SDK_KEY)).resolves.toBeNull()
  })
})
