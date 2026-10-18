// @vitest-environment node
//
// The edge SDK runs on servers, never in a browser. The default DOM test
// environment implements the Fetch spec's forbidden request headers, so a
// `Cookie` set through `new Request(url, { headers })` is silently dropped and
// the visitor a real request carries disappears; its `Headers` iterator also
// keeps the original header-name casing. Node reproduces what these platforms
// actually hand the adapter.
// =====================================================================
// adapters/lambdaEdge.ts — CloudFront conversion, contextFrom from the
// cloudfront-viewer-* headers, and the two bugs this rewrite fixed (dropped
// response body, no way to continue to the origin).
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EvalContext } from '@avsbhq/core'
import {
  cfHeader,
  cfRequestToWebRequest,
  createLambdaEdgeHandler,
  lambdaEdgeContextFrom,
  lambdaEdgeGeo,
  webResponseToCFResponse,
  type CFRequest,
  type CFResponse,
  type LambdaEdgeEvent,
} from './lambdaEdge'
import { resetLogOnce } from '../logger'
import { VALID_SDK_KEY, VISITOR_HEADER, jsonResponse, snippetCookie, testDatafile } from '../fixtures'

function cfReq(headers: Record<string, string> = {}, overrides: Partial<CFRequest> = {}): CFRequest {
  const cfHeaders: Record<string, Array<{ key?: string; value: string }>> = {}
  for (const [name, value] of Object.entries(headers)) {
    cfHeaders[name.toLowerCase()] = [{ key: name, value }]
  }
  return {
    uri: '/checkout',
    method: 'GET',
    querystring: 'step=2',
    headers: { host: [{ key: 'Host', value: 'shop.example.com' }], ...cfHeaders },
    ...overrides,
  }
}

function cfEvent(request: CFRequest): LambdaEdgeEvent {
  return { Records: [{ cf: { request } }] }
}

function isCFResponse(value: CFResponse | CFRequest): value is CFResponse {
  return 'status' in value
}

beforeEach(() => {
  resetLogOnce()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(testDatafile)))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------
// CloudFront conversion
// ---------------------------------------------------------------------

describe('cfRequestToWebRequest', () => {
  it('builds a URL from the real host, the uri, and the querystring', () => {
    const req = cfRequestToWebRequest(cfReq())

    // The old conversion hardcoded `https://lambda.edge` and dropped the
    // query, so `new URL(req.url).host` was a placeholder and page targeting
    // on a query parameter could not work.
    expect(req.url).toBe('https://shop.example.com/checkout?step=2')
  })

  it('omits the querystring when there is none', () => {
    expect(cfRequestToWebRequest(cfReq({}, { querystring: '' })).url).toBe(
      'https://shop.example.com/checkout',
    )
  })

  it('copies every CloudFront header onto the web request', () => {
    const req = cfRequestToWebRequest(cfReq({ 'User-Agent': 'curl/8', 'X-Custom': 'v' }))

    expect(req.headers.get('user-agent')).toBe('curl/8')
    expect(req.headers.get('x-custom')).toBe('v')
  })

  it('does not attach a body to a GET, which would throw', () => {
    const req = cfRequestToWebRequest(cfReq({}, { body: { data: 'ignored' } }))

    expect(req.method).toBe('GET')
    expect(req.body).toBeNull()
  })

  it('decodes a base64 body on a POST', async () => {
    const req = cfRequestToWebRequest(
      cfReq({}, { method: 'POST', body: { data: btoa('{"a":1}'), encoding: 'base64' } }),
    )

    expect(await req.text()).toBe('{"a":1}')
  })
})

describe('webResponseToCFResponse', () => {
  it('carries the response body across', async () => {
    // The bug this closes: the body was never read, so every short-circuited
    // response reached the browser empty.
    const cf = await webResponseToCFResponse(new Response('hello', { status: 200 }))

    expect(cf.body).toBe('hello')
    expect(cf.status).toBe('200')
  })

  it('lowercases header names, as the CloudFront event format requires', async () => {
    const cf = await webResponseToCFResponse(
      new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    )

    expect(cf.headers?.['content-type']).toEqual([
      { key: 'content-type', value: 'application/json' },
    ])
  })

  it('falls back to OK when the response carries no status text', async () => {
    // `null`, not `''`: a 204 is a null-body status, and the Response
    // constructor rejects a body for one.
    const cf = await webResponseToCFResponse(new Response(null, { status: 204 }))

    expect(cf.statusDescription).toBeTruthy()
  })
})

describe('cfHeader', () => {
  it('reads a header case-insensitively', () => {
    expect(cfHeader(cfReq({ 'X-Custom': 'v' }), 'X-CUSTOM')).toBe('v')
  })

  it('returns null for an absent header', () => {
    expect(cfHeader(cfReq(), 'x-nope')).toBeNull()
  })
})

// ---------------------------------------------------------------------
// contextFrom
// ---------------------------------------------------------------------

describe('lambdaEdgeGeo', () => {
  it('reads the cloudfront-viewer-* headers', () => {
    const request = cfReq({
      'CloudFront-Viewer-Country': 'CA',
      'CloudFront-Viewer-Country-Region': 'ON',
      'CloudFront-Viewer-City': 'Toronto',
      'CloudFront-Viewer-Postal-Code': 'M5V',
      'CloudFront-Viewer-Time-Zone': 'America/Toronto',
      'CloudFront-Viewer-Latitude': '43.65',
      'CloudFront-Viewer-Longitude': '-79.38',
    })

    expect(lambdaEdgeGeo(request)).toEqual({
      country: 'CA',
      region: 'ON',
      city: 'Toronto',
      postalCode: 'M5V',
      timezone: 'America/Toronto',
      latitude: 43.65,
      longitude: -79.38,
    })
  })

  it('reports nothing when the distribution policy does not forward them', () => {
    // CloudFront only adds these headers when the attached cache or
    // origin-request policy includes them, so absence is normal and must not
    // become an empty string.
    const geo = lambdaEdgeGeo(cfReq())

    expect(Object.values(geo).every((v) => v === undefined)).toBe(true)
  })
})

describe('lambdaEdgeContextFrom', () => {
  it('extracts identity, geo, and page attributes', () => {
    const request = cfReq({
      [VISITOR_HEADER]: 'v_abc',
      'CloudFront-Viewer-Country': 'CA',
    })

    expect(lambdaEdgeContextFrom(cfRequestToWebRequest(request), request)).toEqual({
      kind: 'user',
      key: 'v_abc',
      url: 'https://shop.example.com/checkout?step=2',
      path: '/checkout',
      host: 'shop.example.com',
      country: 'CA',
    })
  })

  it('adopts the snippet cookie when no header is present', () => {
    const request = cfReq({ Cookie: `_avsb_visitor=${snippetCookie('v_snip')}` })

    expect(lambdaEdgeContextFrom(cfRequestToWebRequest(request), request).key).toBe('v_snip')
  })

  it('never uses clientIp as the bucketing key', () => {
    const request = cfReq({}, { clientIp: '203.0.113.7' })

    expect(lambdaEdgeContextFrom(cfRequestToWebRequest(request), request).key).toBe('')
  })
})

// ---------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------

describe('createLambdaEdgeHandler', () => {
  it('returns a CloudFront response, body included, when the handler answers', async () => {
    const handler = createLambdaEdgeHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) =>
        Response.json({ enabled: client.getBoolFlag('always-on', false).value }),
    })

    const out = await handler(cfEvent(cfReq({ [VISITOR_HEADER]: 'v_abc' })))

    expect(isCFResponse(out)).toBe(true)
    if (!isCFResponse(out)) return
    expect(out.status).toBe('200')
    expect(JSON.parse(String(out.body))).toEqual({ enabled: true })
  })

  it('returns the possibly rewritten request when the handler answers nothing', async () => {
    const handler = createLambdaEdgeHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client, cfRequest) => {
        if (client.getBoolFlag('always-on', false).isEnabled()) {
          cfRequest.uri = `/v2${cfRequest.uri}`
        }
      },
    })

    const out = await handler(cfEvent(cfReq({ [VISITOR_HEADER]: 'v_abc' })))

    // The origin-routing pattern the README documented was impossible before:
    // the adapter always produced a response.
    expect(isCFResponse(out)).toBe(false)
    if (isCFResponse(out)) return
    expect(out.uri).toBe('/v2/checkout')
  })

  it('calls a supplied contextFrom with the web request and the CF request', async () => {
    const contextFrom = vi.fn(
      (_req: Request, cfRequest: CFRequest): EvalContext => ({
        kind: 'user',
        key: cfRequest.clientIp ?? 'none',
      }),
    )
    let bound: EvalContext | undefined

    const handler = createLambdaEdgeHandler({
      sdkKey: VALID_SDK_KEY,
      contextFrom,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        bound = client.getContext()
        return new Response('ok')
      },
    })
    await handler(cfEvent(cfReq({}, { clientIp: '203.0.113.7' })))

    // The option used to be declared and never called on every adapter.
    expect(contextFrom).toHaveBeenCalledTimes(1)
    expect(bound).toEqual({ kind: 'user', key: '203.0.113.7' })
  })

  it('awaits the flush, because Lambda freezes on return', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }))
    vi.stubGlobal('fetch', mockFetch)

    const handler = createLambdaEdgeHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { datafile: testDatafile, logLevel: 'silent' },
      handler: async (_req, client) => {
        client.getFlag('checkout-v2', false)
        return new Response('ok')
      },
    })
    await handler(cfEvent(cfReq({ [VISITOR_HEADER]: 'v_abc' })))

    expect(
      mockFetch.mock.calls.some(([url]) => String(url).includes('/v1/collect/batch')),
    ).toBe(true)
  })

  it('answers 500 with the reason when the event carries no record', async () => {
    const handler = createLambdaEdgeHandler({
      sdkKey: VALID_SDK_KEY,
      clientOptions: { logLevel: 'silent' },
      handler: async () => new Response('never reached'),
    })

    const out = await handler({ Records: [] })

    expect(isCFResponse(out)).toBe(true)
    if (!isCFResponse(out)) return
    expect(out.status).toBe('500')
    expect(out.statusDescription).toContain('No CloudFront record')
  })
})
