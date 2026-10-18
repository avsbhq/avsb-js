// =====================================================================
// adapters/netlify.ts — contextFrom extraction from context.geo, the
// platform cookie helper, and the waitUntil wiring.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EvalContext } from '@avsbhq/core'
import {
  createNetlifyHandler,
  netlifyContextFrom,
  netlifyGeo,
  type NetlifyContext,
} from './netlify'
import { resetLogOnce } from '../logger'
import {
  VALID_SDK_KEY,
  VISITOR_HEADER,
  jsonResponse,
  requestWith,
  snippetCookie,
  testDatafile,
} from '../fixtures'

function netlifyCtx(overrides: NetlifyContext = {}): NetlifyContext {
  return overrides
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

describe('netlifyGeo', () => {
  it('flattens the nested country and subdivision objects', () => {
    expect(
      netlifyGeo({
        geo: {
          city: 'Dublin',
          country: { code: 'IE', name: 'Ireland' },
          subdivision: { code: 'L', name: 'Leinster' },
          timezone: 'Europe/Dublin',
          latitude: 53.35,
          longitude: -6.26,
        },
      }),
    ).toEqual({
      // Netlify nests these; every other runtime is flat, so a `country`
      // audience would silently stop matching without this mapping.
      country: 'IE',
      region: 'L',
      city: 'Dublin',
      timezone: 'Europe/Dublin',
      latitude: 53.35,
      longitude: -6.26,
    })
  })

  it('returns nothing when the context carries no geo', () => {
    expect(netlifyGeo({})).toEqual({})
    expect(netlifyGeo(undefined)).toEqual({})
  })

  it('tolerates a partially populated geo object', () => {
    expect(netlifyGeo({ geo: { city: 'Dublin' } }).city).toBe('Dublin')
    expect(netlifyGeo({ geo: { city: 'Dublin' } }).country).toBeUndefined()
  })
})

describe('netlifyContextFrom', () => {
  it('extracts identity, geo, and page attributes', () => {
    const ctx = netlifyContextFrom(
      requestWith({ [VISITOR_HEADER]: 'v_abc' }, 'https://shop.example.com/pricing'),
      netlifyCtx({ geo: { country: { code: 'IE' } } }),
    )

    expect(ctx).toEqual({
      kind: 'user',
      key: 'v_abc',
      url: 'https://shop.example.com/pricing',
      path: '/pricing',
      host: 'shop.example.com',
      country: 'IE',
    })
  })

  it('falls back to the platform cookie helper when the header is absent', () => {
    // A Netlify redirect or an upstream function can rewrite the Cookie
    // header while `context.cookies` still sees the original request.
    const ctx = netlifyContextFrom(
      requestWith({}),
      netlifyCtx({ cookies: { get: () => snippetCookie('v_platform') } }),
    )

    expect(ctx.key).toBe('v_platform')
  })

  it('prefers the request header over the platform cookie', () => {
    const ctx = netlifyContextFrom(
      requestWith({ [VISITOR_HEADER]: 'v_header' }),
      netlifyCtx({ cookies: { get: () => snippetCookie('v_platform') } }),
    )

    expect(ctx.key).toBe('v_header')
  })

  it('never uses context.ip as the bucketing key', () => {
    expect(netlifyContextFrom(requestWith({}), netlifyCtx({ ip: '203.0.113.7' })).key).toBe('')
  })
})

// ---------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------

describe('createNetlifyHandler', () => {
  it('binds the extracted context so the handler needs no context argument', async () => {
    let value: string | undefined

    const handler = createNetlifyHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        value = client.getStringFlag('theme', 'light').value
        return Response.json({ ok: true })
      },
    })
    const res = await handler(requestWith({ [VISITOR_HEADER]: 'v_abc' }), netlifyCtx())

    expect(res.status).toBe(200)
    expect(value).toBe('midnight')
  })

  it('calls a supplied contextFrom with the request and the Netlify context', async () => {
    const contextFrom = vi.fn(
      (_req: Request, ctx: NetlifyContext): EvalContext => ({
        kind: 'user',
        key: ctx.geo?.city ?? 'none',
      }),
    )
    let bound: EvalContext | undefined

    const handler = createNetlifyHandler({
      sdkKey: VALID_SDK_KEY,
      contextFrom,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        bound = client.getContext()
        return new Response('ok')
      },
    })
    await handler(requestWith({}), netlifyCtx({ geo: { city: 'Dublin' } }))

    // The option used to be declared and never called on every adapter.
    expect(contextFrom).toHaveBeenCalledTimes(1)
    expect(bound).toEqual({ kind: 'user', key: 'Dublin' })
  })

  it('passes the Netlify context through to the handler', async () => {
    let seen: NetlifyContext | undefined
    const ctx = netlifyCtx({ ip: '203.0.113.7' })

    const handler = createNetlifyHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, _client, netlify) => {
        seen = netlify
        return new Response('ok')
      },
    })
    await handler(requestWith({}), ctx)

    expect(seen).toBe(ctx)
  })

  it('defers the flush to context.waitUntil when it is available', async () => {
    const waitUntil = vi.fn()

    const handler = createNetlifyHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async () => new Response('ok'),
    })
    await handler(requestWith({}), netlifyCtx({ waitUntil }))

    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise))
  })

  it('awaits the flush when the context has no waitUntil', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }))
    vi.stubGlobal('fetch', mockFetch)

    const handler = createNetlifyHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        client.getFlag('checkout-v2', false)
        return new Response('ok')
      },
    })
    await handler(requestWith({ [VISITOR_HEADER]: 'v_abc' }), netlifyCtx())

    // The old adapter used `.catch(() => undefined)` here, which dropped the
    // batch whenever the platform did not supply waitUntil.
    expect(
      mockFetch.mock.calls.some(([url]) => String(url).includes('/v1/collect/batch')),
    ).toBe(true)
  })
})
