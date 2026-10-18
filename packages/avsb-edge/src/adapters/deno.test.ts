// @vitest-environment node
//
// The edge SDK runs on servers, never in a browser. The default DOM test
// environment implements the Fetch spec's forbidden request headers, so a
// `Cookie` set through `new Request(url, { headers })` is silently dropped and
// the visitor a real request carries disappears; its `Headers` iterator also
// keeps the original header-name casing. Node reproduces what these platforms
// actually hand the adapter.
// =====================================================================
// adapters/deno.ts — contextFrom (identity only, no platform geo), the
// Deno KV storage adapter, and the awaited flush.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EvalContext } from '@avsbhq/core'
import {
  createDenoHandler,
  createDenoKVAdapter,
  denoContextFrom,
  denoRegion,
  type DenoKV,
} from './deno'
import { resetLogOnce } from '../logger'
import {
  VALID_SDK_KEY,
  VISITOR_HEADER,
  jsonResponse,
  requestWith,
  snippetCookie,
  testDatafile,
} from '../fixtures'

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

describe('denoRegion', () => {
  it('reads DENO_REGION when the environment is readable', () => {
    vi.stubGlobal('Deno', {
      env: { get: (k: string) => (k === 'DENO_REGION' ? 'fra1' : undefined) },
    })

    expect(denoRegion()).toBe('fra1')
  })

  it('returns undefined when --allow-env was not granted', () => {
    vi.stubGlobal('Deno', {
      env: {
        get: () => {
          throw new Error('Requires env access')
        },
      },
    })

    // A permission error must not take the request down.
    expect(denoRegion()).toBeUndefined()
  })

  it('returns undefined outside Deno entirely', () => {
    vi.stubGlobal('Deno', undefined)

    expect(denoRegion()).toBeUndefined()
  })
})

describe('denoContextFrom', () => {
  it('extracts identity and page attributes', () => {
    vi.stubGlobal('Deno', undefined)

    expect(
      denoContextFrom(
        requestWith({ [VISITOR_HEADER]: 'v_abc' }, 'https://shop.example.com/pricing'),
      ),
    ).toEqual({
      kind: 'user',
      key: 'v_abc',
      url: 'https://shop.example.com/pricing',
      path: '/pricing',
      host: 'shop.example.com',
    })
  })

  it('adds no geo attributes at all, because Deno Deploy exposes none', () => {
    vi.stubGlobal('Deno', undefined)

    const ctx = denoContextFrom(requestWith({ [VISITOR_HEADER]: 'v_abc' }))

    // Absence stays absence: an `exists` audience condition can tell "this
    // platform has no geo" from "geo says empty".
    expect('country' in ctx).toBe(false)
    expect('city' in ctx).toBe(false)
  })

  it('adds the Deno region when the environment exposes it', () => {
    vi.stubGlobal('Deno', { env: { get: () => 'fra1' } })

    expect(denoContextFrom(requestWith({})).region).toBe('fra1')
  })

  it('adopts the snippet cookie when no header is present', () => {
    vi.stubGlobal('Deno', undefined)

    expect(
      denoContextFrom(requestWith({ cookie: `_avsb_visitor=${snippetCookie('v_snip')}` })).key,
    ).toBe('v_snip')
  })
})

// ---------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------

describe('createDenoHandler', () => {
  it('binds the extracted context so the handler needs no context argument', async () => {
    let value: boolean | undefined

    const handler = createDenoHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        value = client.getBoolFlag('always-on', false).value
        return new Response('ok')
      },
    })
    await handler(requestWith({ [VISITOR_HEADER]: 'v_abc' }))

    expect(value).toBe(true)
  })

  it('calls a supplied contextFrom with the request and the serve info', async () => {
    const contextFrom = vi.fn(
      (_req: Request, info?: { remoteAddr?: { hostname?: string } }): EvalContext => ({
        kind: 'user',
        key: info?.remoteAddr?.hostname ?? 'none',
      }),
    )
    let bound: EvalContext | undefined

    const handler = createDenoHandler({
      sdkKey: VALID_SDK_KEY,
      contextFrom,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        bound = client.getContext()
        return new Response('ok')
      },
    })
    await handler(requestWith({}), { remoteAddr: { hostname: '203.0.113.7' } })

    // The option used to be declared and never called on every adapter.
    expect(contextFrom).toHaveBeenCalledTimes(1)
    expect(bound).toEqual({ kind: 'user', key: '203.0.113.7' })
  })

  it('awaits the flush, because Deno Deploy has no waitUntil', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }))
    vi.stubGlobal('fetch', mockFetch)

    const handler = createDenoHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        client.getFlag('checkout-v2', false)
        return new Response('ok')
      },
    })
    await handler(requestWith({ [VISITOR_HEADER]: 'v_abc' }))

    expect(
      mockFetch.mock.calls.some(([url]) => String(url).includes('/v1/collect/batch')),
    ).toBe(true)
  })

  it('reads the datafile from Deno KV before touching the network', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)
    const kv: DenoKV = {
      get: vi.fn().mockResolvedValue({ value: { datafile: testDatafile, cachedAt: Date.now() } }),
      set: vi.fn().mockResolvedValue(undefined),
    }

    const handler = createDenoHandler({
      sdkKey: VALID_SDK_KEY,
      kv,
      clientOptions: { logLevel: 'silent' },
      handler: async () => new Response('ok'),
    })
    await handler(requestWith({}))

    expect(kv.get).toHaveBeenCalledWith(['avsb', 'df', VALID_SDK_KEY])
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------
// Deno KV storage
// ---------------------------------------------------------------------

describe('createDenoKVAdapter', () => {
  it('round-trips a datafile under the avsb/df key path', async () => {
    const store = new Map<string, unknown>()
    const kv: DenoKV = {
      get: vi.fn((key: string[]) => Promise.resolve({ value: store.get(key.join('/')) ?? null })),
      set: vi.fn((key: string[], value: unknown) => {
        store.set(key.join('/'), value)
        return Promise.resolve(undefined)
      }),
    }
    const storage = createDenoKVAdapter(kv)

    await storage.datafileSet(VALID_SDK_KEY, testDatafile)
    const entry = await storage.datafileGet(VALID_SDK_KEY)

    expect(entry?.datafile.sdkKey).toBe(VALID_SDK_KEY)
    expect(typeof entry?.cachedAt).toBe('number')
  })

  it('reports a miss for an absent key and for a value with no datafile', async () => {
    const absent = createDenoKVAdapter({ get: vi.fn().mockResolvedValue(null), set: vi.fn() })
    const wrongShape = createDenoKVAdapter({
      get: vi.fn().mockResolvedValue({ value: { other: 1 } }),
      set: vi.fn(),
    })

    expect(await absent.datafileGet(VALID_SDK_KEY)).toBeNull()
    expect(await wrongShape.datafileGet(VALID_SDK_KEY)).toBeNull()
  })

  it('stamps a missing cachedAt as now rather than epoch zero', async () => {
    const storage = createDenoKVAdapter({
      get: vi.fn().mockResolvedValue({ value: { datafile: testDatafile } }),
      set: vi.fn(),
    })

    // Epoch zero would make a hand-populated KV entry permanently stale.
    expect((await storage.datafileGet(VALID_SDK_KEY))?.cachedAt).toBeGreaterThan(
      1_700_000_000_000,
    )
  })

  it('survives a KV outage by reporting a miss', async () => {
    const storage = createDenoKVAdapter({
      get: vi.fn().mockRejectedValue(new Error('kv unavailable')),
      set: vi.fn(),
    })

    await expect(storage.datafileGet(VALID_SDK_KEY)).resolves.toBeNull()
  })
})
