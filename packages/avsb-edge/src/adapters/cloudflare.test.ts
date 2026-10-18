// =====================================================================
// adapters/cloudflare.ts — contextFrom extraction, env-resolved bindings,
// KV storage, and the waitUntil wiring.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EvalContext } from '@avsbhq/core'
import {
  cloudflareContextFrom,
  cloudflareGeo,
  createCloudflareHandler,
  createKVStorageAdapter,
  type CloudflareRequest,
  type KVNamespace,
  type CloudflareRequestProperties,
} from './cloudflare'
import { AvsbEdgeClient } from '../AvsbEdgeClient'
import { resetLogOnce } from '../logger'
import {
  VALID_SDK_KEY,
  VISITOR_HEADER,
  cfRequest,
  jsonResponse,
  testDatafile,
} from '../fixtures'

interface Env {
  AVSB_SDK_KEY: string
  AVSB_KV?: KVNamespace
}

/** KV double with explicit signatures, so assignability is unambiguous. */
function makeKV(stored: string | null = null) {
  return {
    get: vi.fn((_key: string): Promise<string | null> => Promise.resolve(stored)),
    put: vi.fn((_key: string, _value: string): Promise<void> => Promise.resolve()),
  }
}

function makeCtx(): { waitUntil: ReturnType<typeof vi.fn> } {
  return { waitUntil: vi.fn() }
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

describe('cloudflareGeo', () => {
  it('reads the cf object', () => {
    const cf: CloudflareRequestProperties = {
      country: 'GB',
      region: 'England',
      city: 'London',
      continent: 'EU',
      postalCode: 'EC1A',
      timezone: 'Europe/London',
      latitude: '51.5074',
      longitude: '-0.1278',
    }

    expect(cloudflareGeo(cfRequest({}, { cf }))).toEqual({
      country: 'GB',
      region: 'England',
      city: 'London',
      continent: 'EU',
      postalCode: 'EC1A',
      timezone: 'Europe/London',
      latitude: 51.5074,
      longitude: -0.1278,
    })
  })

  it('falls back to cf-ipcountry when the cf object is absent', () => {
    // `request.cf` is undefined in local `wrangler dev` and on non-proxied
    // requests, which is exactly when a geo rule would otherwise stop matching.
    expect(cloudflareGeo(cfRequest({ 'cf-ipcountry': 'DE' })).country).toBe('DE')
  })

  it('drops a latitude that is not a finite number', () => {
    expect(cloudflareGeo(cfRequest({}, { cf: { latitude: 'unknown' } })).latitude).toBeUndefined()
  })
})

describe('cloudflareContextFrom', () => {
  it('extracts identity, geo, page, and the Cloudflare extras', () => {
    const req = cfRequest(
      { [VISITOR_HEADER]: 'v_abc', 'user-agent': 'curl/8', 'accept-language': 'en' },
      { cf: { country: 'GB', colo: 'LHR', asn: 13335 }, url: 'https://shop.example.com/cart' },
    )

    expect(cloudflareContextFrom(req)).toEqual({
      kind: 'user',
      key: 'v_abc',
      url: 'https://shop.example.com/cart',
      path: '/cart',
      host: 'shop.example.com',
      userAgent: 'curl/8',
      language: 'en',
      country: 'GB',
      colo: 'LHR',
      asn: 13335,
    })
  })

  it('never uses the client IP as the bucketing key', () => {
    // The bucketing key becomes visitorId on every exposure row, so an IP
    // there would write a personal identifier into analytics storage.
    const req = cfRequest({ 'cf-connecting-ip': '203.0.113.7' })

    expect(cloudflareContextFrom(req).key).toBe('')
  })
})

// ---------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------

describe('createCloudflareHandler', () => {
  it('resolves sdkKey and kv from env, which is the only place they exist', async () => {
    const kv = makeKV()
    const env: Env = { AVSB_SDK_KEY: VALID_SDK_KEY, AVSB_KV: kv }

    const handler = createCloudflareHandler<Env>({
      sdkKey: (e) => e.AVSB_SDK_KEY,
      kv: (e) => e.AVSB_KV,
      handler: async () => new Response('ok'),
    })
    await handler(cfRequest({}), env, makeCtx())

    expect(kv.get).toHaveBeenCalledWith(`avsb:df:${VALID_SDK_KEY}`)
  })

  it('accepts a literal sdkKey too', async () => {
    let seen: AvsbEdgeClient | undefined

    const handler = createCloudflareHandler<Env>({
      sdkKey: VALID_SDK_KEY,
      handler: async (_req, client) => {
        seen = client
        return new Response('ok')
      },
    })
    await handler(cfRequest({}), { AVSB_SDK_KEY: 'unused' }, makeCtx())

    expect(seen?.isReady()).toBe(true)
  })

  it('binds the extracted context so the handler needs no context argument', async () => {
    let value: boolean | undefined

    const handler = createCloudflareHandler<Env>({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        value = client.getBoolFlag('always-on', false).value
        return Response.json({ ok: true })
      },
    })

    const res = await handler(
      cfRequest({ [VISITOR_HEADER]: 'v_abc' }),
      { AVSB_SDK_KEY: VALID_SDK_KEY },
      makeCtx(),
    )

    expect(res.status).toBe(200)
    expect(value).toBe(true)
  })

  it('calls a supplied contextFrom instead of the default', async () => {
    const contextFrom = vi.fn(
      (_req: CloudflareRequest, _env: Env): EvalContext => ({ kind: 'user', key: 'custom' }),
    )
    let bound: EvalContext | undefined

    const handler = createCloudflareHandler<Env>({
      sdkKey: VALID_SDK_KEY,
      contextFrom,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        bound = client.getContext()
        return new Response('ok')
      },
    })
    await handler(cfRequest({}), { AVSB_SDK_KEY: VALID_SDK_KEY }, makeCtx())

    // The option used to be declared and never called on every adapter.
    expect(contextFrom).toHaveBeenCalledTimes(1)
    expect(bound).toEqual({ kind: 'user', key: 'custom' })
  })

  it('defers the flush to ctx.waitUntil so the response is not delayed', async () => {
    const ctx = makeCtx()

    const handler = createCloudflareHandler<Env>({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async () => new Response('ok'),
    })
    await handler(cfRequest({}), { AVSB_SDK_KEY: VALID_SDK_KEY }, ctx)

    expect(ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise))
  })
})

// ---------------------------------------------------------------------
// KV storage
// ---------------------------------------------------------------------

describe('createKVStorageAdapter', () => {
  it('round-trips a datafile with a cachedAt stamp', async () => {
    const store = new Map<string, string>()
    const kv = {
      get: vi.fn((key: string): Promise<string | null> => Promise.resolve(store.get(key) ?? null)),
      put: vi.fn((key: string, value: string): Promise<void> => {
        store.set(key, value)
        return Promise.resolve()
      }),
    }
    const storage = createKVStorageAdapter(kv)

    await storage.datafileSet(VALID_SDK_KEY, testDatafile)
    const read = await storage.datafileGet(VALID_SDK_KEY)

    expect(read?.datafile.sdkKey).toBe(VALID_SDK_KEY)
    expect(typeof read?.cachedAt).toBe('number')
  })

  it('writes a retention TTL, clamped to the Cloudflare 60s floor', async () => {
    const kv = makeKV()

    await createKVStorageAdapter(kv, 5).datafileSet(VALID_SDK_KEY, testDatafile)

    // Retention, not freshness: the client's cacheTtlMs decides whether a
    // stored copy is fresh enough to serve, which is what keeps the degraded
    // path reachable.
    expect(kv.put).toHaveBeenCalledWith(expect.any(String), expect.any(String), {
      expirationTtl: 60,
    })
  })

  it('treats an unparseable KV value as a miss rather than throwing', async () => {
    const kv = makeKV('{not json')

    await expect(createKVStorageAdapter(kv).datafileGet(VALID_SDK_KEY)).resolves.toBeNull()
  })

  it('reports no sticky assignment, which this runtime does not implement', () => {
    const storage = createKVStorageAdapter(makeKV())

    expect(storage.stickyLookup('user_42', 'checkout-v2')).toBeNull()
    expect(storage.isHealthy()).toBe(true)
  })
})
