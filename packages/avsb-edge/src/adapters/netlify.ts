// =====================================================================
// @avsbhq/edge/netlify — Netlify Edge Functions adapter.
//
// Netlify Edge Functions run on Deno and receive `(request, context)`.
// Types are declared structurally, so there is no dependency on
// `@netlify/edge-functions`.
//
// WHAT contextFrom EXTRACTS on Netlify:
//
//   key        `x-avsb-visitor-id` header, then the snippet's
//              `_avsb_visitor` cookie, then `context.cookies.get(...)` when
//              the platform helper is present. Never the IP.
//   geo        `context.geo`: country.code, subdivision.code, city,
//              timezone, latitude, longitude. Netlify nests country and
//              subdivision as objects, which is why this mapping exists.
//   page       url, path, host from the request URL; referrer, userAgent,
//              language from headers.
//
// Netlify Edge Functions expose `context.waitUntil`, so events flush after
// the response. There is no platform KV binding for this adapter to use;
// pass your own `storage` through `clientOptions` if you have one (for
// example a Netlify Blobs-backed adapter).
// =====================================================================

import type { EvalContext, SingleContext } from '@avsbhq/core'
import { AvsbEdgeClient } from '../AvsbEdgeClient'
import type { AdapterClientOptions } from '../types'
import {
  buildRequestContext,
  readSnippetVisitorId,
  readVisitorId,
  VISITOR_COOKIE_NAME,
  type EdgeGeo,
} from '../requestContext'

// ---------------------------------------------------------------------
// Structural Netlify context.
// ---------------------------------------------------------------------

export interface NetlifyGeo {
  city?: string
  country?: { code?: string; name?: string }
  subdivision?: { code?: string; name?: string }
  timezone?: string
  latitude?: number
  longitude?: number
}

export interface NetlifyContext {
  /** Available on Netlify Edge Function context. */
  waitUntil?: (p: Promise<unknown>) => void
  /** Netlify's IP-derived location for this request. */
  geo?: NetlifyGeo
  /** Netlify's cookie helper. */
  cookies?: { get?: (name: string) => string | undefined }
  /** Client IP, per Netlify's context API. */
  ip?: string
  /** Continue to the next function or to the origin. */
  next?: () => Promise<Response>
}

// ---------------------------------------------------------------------
// contextFrom
// ---------------------------------------------------------------------

/** Flatten Netlify's nested geo onto the shared attribute names. */
export function netlifyGeo(ctx: NetlifyContext | undefined): EdgeGeo {
  const geo = ctx?.geo
  if (!geo) return {}
  return {
    country: geo.country?.code,
    region: geo.subdivision?.code,
    city: geo.city,
    timezone: geo.timezone,
    latitude: geo.latitude,
    longitude: geo.longitude,
  }
}

/**
 * The context this adapter binds when no `contextFrom` is supplied. Exported
 * so a custom `contextFrom` can extend it.
 */
export function netlifyContextFrom(req: Request, ctx: NetlifyContext): SingleContext {
  // Netlify's own cookie helper is consulted as a third source because a
  // Netlify redirect or an upstream function can rewrite the Cookie header
  // while `context.cookies` still sees the original request.
  const fromPlatformCookie =
    typeof ctx.cookies?.get === 'function'
      ? readSnippetVisitorId(ctx.cookies.get(VISITOR_COOKIE_NAME))
      : null

  return buildRequestContext({
    visitorId: readVisitorId(req.headers) ?? fromPlatformCookie,
    headers: req.headers,
    url: req.url,
    geo: netlifyGeo(ctx),
  })
}

// ---------------------------------------------------------------------
// createNetlifyHandler
// ---------------------------------------------------------------------

export interface NetlifyHandlerOptions {
  sdkKey: string
  handler: (
    req: Request,
    client: AvsbEdgeClient,
    netlifyCtx: NetlifyContext,
  ) => Promise<Response>
  /** Optional: the default reads the visitor id and `context.geo`. */
  contextFrom?: (req: Request, netlifyCtx: NetlifyContext) => EvalContext | undefined
  clientOptions?: AdapterClientOptions
}

/**
 * Returns a Netlify Edge Function handler.
 *
 * @example
 * ```ts
 * import { createNetlifyHandler } from '@avsbhq/edge/netlify'
 *
 * export default createNetlifyHandler({
 *   sdkKey: Netlify.env.get('AVSB_SDK_KEY') ?? '',
 *   handler: async (req, client) => {
 *     const theme = client.getStringFlag('theme', 'light')
 *     return Response.json({ theme: theme.value })
 *   },
 * })
 *
 * export const config = { path: '/api/theme' }
 * ```
 */
export function createNetlifyHandler(
  opts: NetlifyHandlerOptions,
): (req: Request, ctx: NetlifyContext) => Promise<Response> {
  return async (req, netlifyCtx) => {
    const waitUntil = netlifyCtx.waitUntil

    const client = new AvsbEdgeClient({
      ...opts.clientOptions,
      sdkKey: opts.sdkKey,
      context: opts.contextFrom
        ? opts.contextFrom(req, netlifyCtx)
        : netlifyContextFrom(req, netlifyCtx),
      pageUrl: req.url,
      waitUntil: waitUntil ? (p) => waitUntil(p) : undefined,
    })

    await client.init()

    const response = await opts.handler(req, client, netlifyCtx)

    if (waitUntil) {
      waitUntil(client.flushEvents())
    } else {
      // Awaited rather than fire-and-forget: without `waitUntil` the isolate
      // can be frozen the moment the response is returned, and the old
      // `.catch(() => undefined)` here silently dropped every batch.
      await client.flushEvents()
    }

    return response
  }
}
