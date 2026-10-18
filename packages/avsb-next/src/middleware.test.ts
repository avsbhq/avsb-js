// @vitest-environment node
//
// Middleware runs on a server runtime, never in a browser. The default DOM test
// environment implements the Fetch spec's forbidden request headers, so a
// `Cookie` set through `new Request(url, { headers })` is silently dropped and
// every request looks like a first visit.
/**
 * `withAvsb`, the replacement for `avsbNextAppMiddleware` (breaking change
 * B8).
 *
 * THE BUG IT REPLACES: the old export returned `new Response(null, {status:
 * 200})` for every matched request. Next.js treats a middleware's return
 * value as THE response, so the documented catch-all matcher served an
 * empty 200 for every page. The first test below is the regression: a
 * wrapper must never invent a response body of its own.
 */
import { describe, it, expect, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { withAvsb } from './middleware'
import type { NextAppAvsbServer } from './middleware'
import { AVSB_ANON_COOKIE, isAnonId } from './anonCookie'
import type { EvalContext } from '@avsbhq/core'

const USER_CTX: EvalContext = { kind: 'user', key: 'user-test' }

function makeRequest(url = 'https://example.com/pricing', cookie?: string): NextRequest {
  return new NextRequest(new Request(url, cookie ? { headers: { cookie } } : undefined))
}

function makeServer(): NextAppAvsbServer {
  return {
    forUser: vi.fn().mockReturnValue({
      getFlag: vi.fn(),
      getAllFlags: vi.fn().mockReturnValue({}),
    }),
  }
}

describe('withAvsb', () => {
  it('continues the request when there is no middleware to run', async () => {
    const middleware = withAvsb()

    const response = await middleware(makeRequest())

    // NextResponse.next() is signalled by a header, not by a body: an
    // empty 200 without it is what blanked the site.
    expect(response.status).toBe(200)
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(await response.text()).toBe('')
  })

  it('passes the caller middleware response through untouched', async () => {
    const redirect = NextResponse.redirect(new URL('https://example.com/new'))
    const middleware = withAvsb(() => redirect)

    const response = await middleware(makeRequest())

    expect(response.status).toBe(redirect.status)
    expect(response.headers.get('location')).toBe('https://example.com/new')
  })

  it('continues when the caller middleware returns nothing', async () => {
    const inner = vi.fn().mockReturnValue(undefined)
    const middleware = withAvsb(inner)

    const response = await middleware(makeRequest())

    expect(inner).toHaveBeenCalledOnce()
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it('mints the anonymous visitor cookie when the request has none', async () => {
    const middleware = withAvsb()

    const response = await middleware(makeRequest())

    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${AVSB_ANON_COOKIE}=`)
    const value = response.cookies.get(AVSB_ANON_COOKIE)?.value
    expect(isAnonId(value)).toBe(true)
    expect(setCookie.toLowerCase()).toContain('max-age=')
  })

  it('leaves an existing visitor id alone, so the visitor keeps their variation', async () => {
    const existing = 'anon_11111111-2222-3333-4444-555555555555'
    const middleware = withAvsb()

    const response = await middleware(
      makeRequest('https://example.com/', `${AVSB_ANON_COOKIE}=${existing}`),
    )

    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('replaces a value that is not one of ours rather than bucketing on it', async () => {
    const middleware = withAvsb()

    const response = await middleware(
      makeRequest('https://example.com/', `${AVSB_ANON_COOKIE}=nonsense`),
    )

    const value = response.cookies.get(AVSB_ANON_COOKIE)?.value
    expect(isAnonId(value)).toBe(true)
    expect(value).not.toBe('nonsense')
  })

  it('sets the cookie on a redirect too', async () => {
    const middleware = withAvsb(() => NextResponse.redirect(new URL('https://example.com/new')))

    const response = await middleware(makeRequest())

    expect(isAnonId(response.cookies.get(AVSB_ANON_COOKIE)?.value)).toBe(true)
  })

  it('writes no cookie when the caller turns it off', async () => {
    const middleware = withAvsb(undefined, { cookie: false })

    const response = await middleware(makeRequest())

    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('opens a request scope only when both a server and a contextFrom are given', async () => {
    const server = makeServer()
    const scoped = withAvsb(undefined, { server, contextFrom: () => USER_CTX })

    await scoped(makeRequest())
    expect(server.forUser).toHaveBeenCalledWith(USER_CTX)

    const unscoped = withAvsb(undefined, { server })
    const other = makeServer()
    await unscoped(makeRequest())
    expect(other.forUser).not.toHaveBeenCalled()
  })

  it('skips the scope when contextFrom returns undefined', async () => {
    const server = makeServer()
    const middleware = withAvsb(undefined, { server, contextFrom: () => undefined })

    const response = await middleware(makeRequest())

    expect(server.forUser).not.toHaveBeenCalled()
    expect(response.headers.get('x-middleware-next')).toBe('1')
  })

  it('propagates an error from the caller middleware instead of swallowing it', async () => {
    const middleware = withAvsb(() => {
      throw new Error('boom')
    })

    await expect(middleware(makeRequest())).rejects.toThrow('boom')
  })
})
