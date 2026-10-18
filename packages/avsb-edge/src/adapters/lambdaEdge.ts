// =====================================================================
// @avsbhq/edge/lambda — AWS Lambda@Edge adapter.
//
// CloudFront hands a viewer-request or origin-request event and expects
// EITHER a response (short circuit) or a request (continue to the origin).
// Types are declared structurally, so there is no `@types/aws-lambda` peer.
//
// WHAT contextFrom EXTRACTS on Lambda@Edge:
//
//   key        `x-avsb-visitor-id` header, then the snippet's
//              `_avsb_visitor` cookie. Never `clientIp`.
//   geo        the `cloudfront-viewer-*` headers: country,
//              country-region, city, postal-code, time-zone, latitude,
//              longitude. IMPORTANT: CloudFront only adds these when the
//              attached cache or origin-request policy includes them, so on
//              a distribution without that configuration the context simply
//              has no geo attributes. Nothing is invented and nothing throws.
//   page       url, path, host, built from `cf.request.uri`, the
//              `querystring` field, and the `host` header; referrer,
//              userAgent, language from headers.
//
// TWO BUGS THIS FILE HAD:
//
//   1. The inner handler's response BODY was thrown away: the CF response
//      was built with a status and headers and no body, so every
//      short-circuited response reached the browser empty.
//   2. Returning a CF request to continue to the origin was impossible: the
//      adapter always produced a response, so the classic Lambda@Edge
//      pattern the README documented (rewrite `cf.request.uri` based on a
//      flag, then let CloudFront fetch the origin) could not be written.
//      A handler may now return nothing, and the possibly-mutated request
//      goes back to CloudFront.
//
// Lambda@Edge has no `waitUntil`, so `flushEvents()` is awaited before the
// handler returns; an unawaited promise is cancelled when the invocation
// ends.
// =====================================================================

import type { EvalContext, SingleContext } from '@avsbhq/core'
import { AvsbEdgeClient } from '../AvsbEdgeClient'
import type { AdapterClientOptions } from '../types'
import {
  buildRequestContext,
  readVisitorId,
  toFiniteNumber,
  type EdgeGeo,
} from '../requestContext'

// ---------------------------------------------------------------------
// Structural CloudFront types.
// ---------------------------------------------------------------------

export interface CFHeader {
  key?: string
  value: string
}

export interface CFRequest {
  uri: string
  method: string
  /** Query string without the leading '?'. Empty string when there is none. */
  querystring?: string
  clientIp?: string
  /** Keyed by LOWERCASE header name, per the CloudFront event format. */
  headers: Record<string, CFHeader[]>
  body?: {
    data: string
    encoding?: 'text' | 'base64'
  }
}

export interface CFResponse {
  status: string
  statusDescription: string
  headers?: Record<string, CFHeader[]>
  body?: string
}

export interface CFRecord {
  cf: {
    request: CFRequest
    response?: CFResponse
  }
}

export interface LambdaEdgeEvent {
  Records: CFRecord[]
}

// ---------------------------------------------------------------------
// CloudFront <-> Web standard conversion.
// ---------------------------------------------------------------------

/** Read one header from a CloudFront header map. */
export function cfHeader(cfReq: CFRequest, name: string): string | null {
  const entries = cfReq.headers[name.toLowerCase()]
  return entries && entries.length > 0 ? entries[0].value : null
}

/** Decode a base64 body without depending on Node's Buffer. */
function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function cfRequestToWebRequest(cfReq: CFRequest): Request {
  const headers = new Headers()
  for (const [name, values] of Object.entries(cfReq.headers)) {
    for (const v of values) headers.append(v.key ?? name, v.value)
  }

  // A GET or HEAD Request cannot carry a body: constructing one throws. Most
  // viewer-request events are GETs, so the guard is the common path.
  const method = cfReq.method.toUpperCase()
  const bodyAllowed = method !== 'GET' && method !== 'HEAD'
  const body =
    bodyAllowed && cfReq.body?.data
      ? cfReq.body.encoding === 'base64'
        ? base64ToBytes(cfReq.body.data)
        : cfReq.body.data
      : undefined

  // The real host, so `new URL(req.url).host` is the site rather than a
  // placeholder, and the querystring, which the old conversion dropped.
  const host = cfHeader(cfReq, 'host') ?? 'lambda.edge'
  const query = cfReq.querystring ? `?${cfReq.querystring}` : ''

  // TS 5.7 lib.dom narrows BodyInit to Uint8Array<ArrayBuffer>; a base64-decoded
  // body is Uint8Array<ArrayBufferLike>, which fetch accepts at runtime.
  return new Request(`https://${host}${cfReq.uri}${query}`, {
    method,
    headers,
    body: body as BodyInit | undefined,
  })
}

export async function webResponseToCFResponse(response: Response): Promise<CFResponse> {
  const cfHeaders: Record<string, CFHeader[]> = {}
  response.headers.forEach((value, key) => {
    cfHeaders[key.toLowerCase()] = [{ key, value }]
  })

  return {
    status: String(response.status),
    statusDescription: response.statusText || 'OK',
    headers: cfHeaders,
    // The body used to be dropped here, so every short-circuited response
    // arrived empty.
    body: await response.text(),
  }
}

// ---------------------------------------------------------------------
// contextFrom
// ---------------------------------------------------------------------

/**
 * CloudFront's viewer geo headers. Present only when the distribution's
 * cache or origin-request policy forwards them.
 */
export function lambdaEdgeGeo(cfReq: CFRequest): EdgeGeo {
  return {
    country: cfHeader(cfReq, 'cloudfront-viewer-country') ?? undefined,
    region: cfHeader(cfReq, 'cloudfront-viewer-country-region') ?? undefined,
    city: cfHeader(cfReq, 'cloudfront-viewer-city') ?? undefined,
    postalCode: cfHeader(cfReq, 'cloudfront-viewer-postal-code') ?? undefined,
    timezone: cfHeader(cfReq, 'cloudfront-viewer-time-zone') ?? undefined,
    latitude: toFiniteNumber(cfHeader(cfReq, 'cloudfront-viewer-latitude')),
    longitude: toFiniteNumber(cfHeader(cfReq, 'cloudfront-viewer-longitude')),
  }
}

/**
 * The context this adapter binds when no `contextFrom` is supplied. Exported
 * so a custom `contextFrom` can extend it.
 */
export function lambdaEdgeContextFrom(req: Request, cfReq: CFRequest): SingleContext {
  return buildRequestContext({
    visitorId: readVisitorId(req.headers),
    headers: req.headers,
    url: req.url,
    geo: lambdaEdgeGeo(cfReq),
  })
}

// ---------------------------------------------------------------------
// createLambdaEdgeHandler
// ---------------------------------------------------------------------

export interface LambdaEdgeHandlerOptions {
  sdkKey: string
  /**
   * Your handler. Return a `Response` to answer from the edge, or return
   * nothing to let CloudFront continue to the origin with `cfRequest` as you
   * left it (mutating `cfRequest.uri` is the documented routing pattern).
   */
  handler: (
    req: Request,
    client: AvsbEdgeClient,
    cfRequest: CFRequest,
  ) => Promise<Response | void>
  /** Optional: the default reads the visitor id and the CloudFront geo headers. */
  contextFrom?: (req: Request, cfRequest: CFRequest) => EvalContext | undefined
  clientOptions?: AdapterClientOptions
}

/**
 * Returns an AWS Lambda@Edge handler for viewer-request and origin-request
 * events.
 *
 * @example
 * ```ts
 * import { createLambdaEdgeHandler } from '@avsbhq/edge/lambda'
 *
 * export const handler = createLambdaEdgeHandler({
 *   sdkKey: process.env.AVSB_SDK_KEY ?? '',
 *   handler: async (req, client, cfRequest) => {
 *     const redesign = client.getBoolFlag('hero-redesign', false)
 *     if (redesign.isEnabled()) cfRequest.uri = `/v2${cfRequest.uri}`
 *     // Returning nothing continues to the origin with the rewritten uri.
 *   },
 * })
 * ```
 */
export function createLambdaEdgeHandler(
  opts: LambdaEdgeHandlerOptions,
): (event: LambdaEdgeEvent) => Promise<CFResponse | CFRequest> {
  return async (event) => {
    const record = event.Records[0]
    if (!record) {
      // Nothing to serve and nothing to forward. A 500 with the reason in the
      // description beats returning undefined, which CloudFront reports as an
      // opaque execution error.
      return { status: '500', statusDescription: 'No CloudFront record in event' }
    }

    const cfReq = record.cf.request
    const webReq = cfRequestToWebRequest(cfReq)

    const client = new AvsbEdgeClient({
      ...opts.clientOptions,
      sdkKey: opts.sdkKey,
      context: opts.contextFrom
        ? opts.contextFrom(webReq, cfReq)
        : lambdaEdgeContextFrom(webReq, cfReq),
      pageUrl: webReq.url,
    })

    await client.init()

    const webResponse = await opts.handler(webReq, client, cfReq)

    // Awaited: Lambda freezes the execution environment when the handler
    // returns, so an unawaited flush is a dropped batch.
    await client.flushEvents()

    return webResponse ? webResponseToCFResponse(webResponse) : cfReq
  }
}
