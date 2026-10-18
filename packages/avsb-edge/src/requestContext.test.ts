// @vitest-environment node
//
// The edge SDK runs on servers, never in a browser. The default DOM test
// environment implements the Fetch spec's forbidden request headers, so a
// `Cookie` set through `new Request(url, { headers })` is silently dropped and
// the visitor a real request carries disappears. Node reproduces what these
// platforms actually hand the reader below.
// =====================================================================
// requestContext.ts — request to EvalContext.
//
// The identity rules asserted here are what every adapter's default
// contextFrom inherits, so a change to one of these changes bucketing on all
// seven runtimes.
// =====================================================================

import { describe, it, expect } from 'vitest'
import {
  VISITOR_COOKIE_NAME,
  VISITOR_HEADER_NAME,
  buildRequestContext,
  pageAttributes,
  parseCookieHeader,
  readSnippetVisitorId,
  readVisitorId,
  toFiniteNumber,
} from './requestContext'
import { requestWith, snippetCookie } from './fixtures'

describe('parseCookieHeader', () => {
  it('parses a multi-cookie header', () => {
    expect(parseCookieHeader('a=1; b=2; c=3')).toEqual({ a: '1', b: '2', c: '3' })
  })

  it('keeps values that contain an equals sign intact', () => {
    // Percent-encoded JSON and base64 both end in '='.
    expect(parseCookieHeader('blob=eyJ2IjoiMSJ9=')).toEqual({ blob: 'eyJ2IjoiMSJ9=' })
  })

  it('returns an empty map for a missing or empty header', () => {
    expect(parseCookieHeader(null)).toEqual({})
    expect(parseCookieHeader('')).toEqual({})
    expect(parseCookieHeader(undefined)).toEqual({})
  })

  it('lets the first occurrence win when a name repeats', () => {
    // A duplicated name means one cookie was set on a narrower path or
    // domain, and the browser sends the more specific one first.
    expect(parseCookieHeader('_avsb_visitor=first; _avsb_visitor=second')).toEqual({
      _avsb_visitor: 'first',
    })
  })

  it('skips malformed segments without failing the whole header', () => {
    expect(parseCookieHeader('broken; a=1')).toEqual({ a: '1' })
  })
})

describe('readSnippetVisitorId', () => {
  it('extracts the id from the snippet cookie shape', () => {
    // The snippet stores percent-encoded JSON `{v, a}`, so reading the raw
    // cookie value gives a JSON blob, not an id.
    expect(readSnippetVisitorId(snippetCookie('v_abc123'))).toBe('v_abc123')
  })

  it('returns null for a cookie that is not the snippet shape', () => {
    expect(readSnippetVisitorId('plain-string')).toBeNull()
    expect(readSnippetVisitorId(encodeURIComponent(JSON.stringify({ other: 1 })))).toBeNull()
  })

  it('returns null for an empty visitor id rather than an empty string', () => {
    expect(readSnippetVisitorId(encodeURIComponent(JSON.stringify({ v: '', a: {} })))).toBeNull()
  })

  it('returns null when nothing was passed', () => {
    expect(readSnippetVisitorId(undefined)).toBeNull()
  })
})

describe('readVisitorId', () => {
  it('prefers the explicit header over the cookie', () => {
    const req = requestWith({
      [VISITOR_HEADER_NAME]: 'from_header',
      cookie: `${VISITOR_COOKIE_NAME}=${snippetCookie('from_cookie')}`,
    })

    expect(readVisitorId(req.headers)).toBe('from_header')
  })

  it('adopts the snippet cookie when no header is present', () => {
    const req = requestWith({ cookie: `${VISITOR_COOKIE_NAME}=${snippetCookie('v_snippet')}` })

    // Shared visitor identity: the same id the snippet reports, so web
    // experiment and edge flag data join for the same person.
    expect(readVisitorId(req.headers)).toBe('v_snippet')
  })

  it('returns null when the request carries no identity at all', () => {
    expect(readVisitorId(requestWith({}).headers)).toBeNull()
  })

  it('ignores a header that is only whitespace', () => {
    expect(readVisitorId(requestWith({ [VISITOR_HEADER_NAME]: '   ' }).headers)).toBeNull()
  })

  it('tolerates a headers double with only a get method', () => {
    expect(readVisitorId({ get: () => null })).toBeNull()
    expect(readVisitorId(undefined)).toBeNull()
  })
})

describe('toFiniteNumber', () => {
  it('parses a numeric header string', () => {
    expect(toFiniteNumber('37.7749')).toBe(37.7749)
  })

  it('refuses values that are not finite numbers', () => {
    expect(toFiniteNumber('not-a-number')).toBeUndefined()
    expect(toFiniteNumber('')).toBeUndefined()
    expect(toFiniteNumber(null)).toBeUndefined()
    expect(toFiniteNumber(undefined)).toBeUndefined()
  })

  it('passes a real number through', () => {
    expect(toFiniteNumber(-122.4194)).toBe(-122.4194)
  })
})

describe('pageAttributes', () => {
  it('splits a request URL into url, path, and host', () => {
    expect(pageAttributes('https://shop.example.com/checkout?step=2')).toEqual({
      url: 'https://shop.example.com/checkout?step=2',
      path: '/checkout',
      host: 'shop.example.com',
    })
  })

  it('keeps a malformed URL as-is rather than throwing', () => {
    expect(pageAttributes('/relative/path')).toEqual({ url: '/relative/path' })
  })

  it('returns nothing when there is no URL', () => {
    expect(pageAttributes(undefined)).toEqual({})
  })
})

describe('buildRequestContext', () => {
  it('builds a flat user context so a legacy audience on country matches', () => {
    // A dashboard CUSTOM_ATTRIBUTE condition with no contextKind resolves
    // against the primary context's attribute bag, so geo must live there and
    // not in a separate `geo` kind.
    const ctx = buildRequestContext({
      visitorId: 'user_42',
      headers: requestWith({ 'user-agent': 'Mozilla/5.0', 'accept-language': 'en-GB' }).headers,
      url: 'https://shop.example.com/checkout?step=2',
      geo: { country: 'GB', city: 'London', latitude: 51.5, longitude: -0.12 },
    })

    expect(ctx).toEqual({
      kind: 'user',
      key: 'user_42',
      url: 'https://shop.example.com/checkout?step=2',
      path: '/checkout',
      host: 'shop.example.com',
      userAgent: 'Mozilla/5.0',
      language: 'en-GB',
      country: 'GB',
      city: 'London',
      latitude: 51.5,
      longitude: -0.12,
    })
  })

  it('omits unknown attributes entirely instead of writing empty strings', () => {
    const ctx = buildRequestContext({ visitorId: 'user_42' })

    // Absence must stay absence so an `exists` audience operator can tell
    // "this platform has no geo" from "geo says empty".
    expect(ctx).toEqual({ kind: 'user', key: 'user_42' })
    expect('country' in ctx).toBe(false)
  })

  it('uses an empty key when there is no identity, never an invented one', () => {
    // A per-request random id would bucket every request differently and turn
    // an experiment into noise; the client warns about the empty key instead.
    expect(buildRequestContext({ visitorId: null }).key).toBe('')
  })

  it('merges platform extras like colo and asn', () => {
    const ctx = buildRequestContext({
      visitorId: 'user_42',
      extra: { colo: 'LHR', asn: 13335 },
    })

    expect(ctx.colo).toBe('LHR')
    expect(ctx.asn).toBe(13335)
  })

  it('drops an extra whose value is undefined', () => {
    const ctx = buildRequestContext({ visitorId: 'user_42', extra: { region: undefined } })

    expect('region' in ctx).toBe(false)
  })

  it('never lets an attribute override the identity it was given', () => {
    // A platform header named `key`, or an `extra` carrying `kind`, must not
    // be able to re-point bucketing: attributes are spread first so identity
    // always wins.
    const ctx = buildRequestContext({
      visitorId: 'user_42',
      extra: { key: 'attacker_supplied', kind: 'admin' },
    })

    expect(ctx.key).toBe('user_42')
    expect(ctx.kind).toBe('user')
  })

  it('honours a custom context kind', () => {
    expect(buildRequestContext({ visitorId: 'acct_1', kind: 'account' }).kind).toBe('account')
  })
})
