// @vitest-environment node
//
// The edge SDK runs on servers, never in a browser. The default DOM test
// environment implements the Fetch spec's forbidden request headers, so a
// `Cookie` set through `new Request(url, { headers })` is silently dropped and
// the visitor a real request carries disappears; its `Headers` iterator also
// keeps the original header-name casing. Node reproduces what these platforms
// actually hand the adapter.
// =====================================================================
// adapters/bun.ts — contextFrom (identity only, no platform geo) and the
// per-handler process cache with its retention bound.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EvalContext } from '@avsbhq/core'
import { bunContextFrom, createBunHandler, createBunMemoryAdapter } from './bun'
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
  vi.useRealTimers()
})

// ---------------------------------------------------------------------
// contextFrom
// ---------------------------------------------------------------------

describe('bunContextFrom', () => {
  it('extracts identity and page attributes', () => {
    expect(
      bunContextFrom(
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

  it('adds no geo attributes, because Bun is a runtime and not a network', () => {
    const ctx = bunContextFrom(requestWith({ [VISITOR_HEADER]: 'v_abc' }))

    expect('country' in ctx).toBe(false)
    expect('city' in ctx).toBe(false)
  })

  it('adopts the snippet cookie when no header is present', () => {
    expect(
      bunContextFrom(requestWith({ cookie: `_avsb_visitor=${snippetCookie('v_snip')}` })).key,
    ).toBe('v_snip')
  })

  it('carries the user agent and language through for targeting', () => {
    const ctx = bunContextFrom(
      requestWith({ 'user-agent': 'Mozilla/5.0', 'accept-language': 'fr-FR' }),
    )

    expect(ctx.userAgent).toBe('Mozilla/5.0')
    expect(ctx.language).toBe('fr-FR')
  })
})

// ---------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------

describe('createBunHandler', () => {
  it('binds the extracted context so the handler needs no context argument', async () => {
    let value: number | undefined

    const handler = createBunHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        value = client.getNumberFlag('missing-number', 25).value
        return new Response('ok')
      },
    })
    await handler(requestWith({ [VISITOR_HEADER]: 'v_abc' }))

    expect(value).toBe(25)
  })

  it('calls a supplied contextFrom with the request and the server', async () => {
    const contextFrom = vi.fn(
      (_req: Request, server?: { requestIP?: (r: Request) => { address?: string } | null }) => ({
        kind: 'user',
        key: server?.requestIP?.(requestWith({}))?.address ?? 'none',
      }),
    )
    let bound: EvalContext | undefined

    const handler = createBunHandler({
      sdkKey: VALID_SDK_KEY,
      contextFrom,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        bound = client.getContext()
        return new Response('ok')
      },
    })
    await handler(requestWith({}), { requestIP: () => ({ address: '203.0.113.7' }) })

    // The option used to be declared and never called on every adapter.
    expect(contextFrom).toHaveBeenCalledTimes(1)
    expect(bound).toEqual({ kind: 'user', key: '203.0.113.7' })
  })

  it('serves later requests from the process cache instead of refetching', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(testDatafile))
    vi.stubGlobal('fetch', mockFetch)

    const handler = createBunHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { logLevel: 'silent', heartbeat: false },
      handler: async () => new Response('ok'),
    })

    await handler(requestWith({}))
    await handler(requestWith({}))

    const datafileFetches = mockFetch.mock.calls.filter(([url]) =>
      String(url).includes('/datafile.json'),
    )
    expect(datafileFetches).toHaveLength(1)
  })

  it('returns the handler response without waiting on the flush', async () => {
    const handler = createBunHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async () => new Response('body', { status: 201 }),
    })

    const res = await handler(requestWith({}))

    // Bun's event loop outlives the response, so the flush is deliberately
    // not awaited.
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('body')
  })
})

// ---------------------------------------------------------------------
// Process cache
// ---------------------------------------------------------------------

describe('createBunMemoryAdapter', () => {
  it('round-trips a datafile', async () => {
    const storage = createBunMemoryAdapter()

    await storage.datafileSet(VALID_SDK_KEY, testDatafile)

    expect((await storage.datafileGet(VALID_SDK_KEY))?.datafile.sdkKey).toBe(VALID_SDK_KEY)
  })

  it('evicts past the retention bound', async () => {
    vi.useFakeTimers()
    const storage = createBunMemoryAdapter(1000)

    await storage.datafileSet(VALID_SDK_KEY, testDatafile)
    vi.advanceTimersByTime(1001)

    expect(await storage.datafileGet(VALID_SDK_KEY)).toBeNull()
  })

  it('reports a miss for a key that was never written', async () => {
    expect(await createBunMemoryAdapter().datafileGet('sdk_production_never0000000000000')).toBeNull()
  })

  it('gives each handler its own map rather than one module-level cache', async () => {
    const a = createBunMemoryAdapter()
    const b = createBunMemoryAdapter()

    await a.datafileSet(VALID_SDK_KEY, testDatafile)

    // Two servers in one process (a test suite spinning up several) must not
    // share one map keyed only by sdkKey.
    expect(await b.datafileGet(VALID_SDK_KEY)).toBeNull()
  })
})
