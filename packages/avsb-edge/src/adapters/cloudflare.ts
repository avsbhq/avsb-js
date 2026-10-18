// =====================================================================
// @avsbhq/edge/cloudflare — Cloudflare Workers adapter.
//
// Types are declared structurally, so there is no dependency on
// `@cloudflare/workers-types` and no peer for a customer to install.
//
// WHAT contextFrom EXTRACTS on Cloudflare:
//
//   key        `x-avsb-visitor-id` header, then the snippet's
//              `_avsb_visitor` cookie. Never the IP: the bucketing key
//              becomes `visitorId` on every exposure row.
//   geo        `request.cf`: country, region, city, continent, postalCode,
//              timezone, latitude, longitude. Falls back to the
//              `cf-ipcountry` header when `request.cf` is absent (it is
//              absent in `wrangler dev` without `--remote`, and on
//              requests Cloudflare did not proxy).
//   extra      `colo` (the Cloudflare data centre) and `asn`, useful for
//              targeting a rollout at one region or network.
//   page       url, path, host from the request URL; referrer, userAgent,
//              language from headers.
//
// BINDINGS: Cloudflare exposes secrets and KV only on the `env` argument of
// `fetch`, never at module scope, so `sdkKey` and `kv` also accept
// `(env) => value`. See ../fromEnv.
// =====================================================================

import type { EvalContext, FlagDatafile, SingleContext, StickyAssignment } from '@avsbhq/core'
import type { UnifiedStorageAdapter } from '@avsbhq/utils'
import { AvsbEdgeClient } from '../AvsbEdgeClient'
import type { AdapterClientOptions } from '../types'
import { resolveFromEnv, type FromEnv } from '../fromEnv'
import {
  buildRequestContext,
  readVisitorId,
  toFiniteNumber,
  type EdgeGeo,
} from '../requestContext'

// ---------------------------------------------------------------------
// Structural Cloudflare surfaces.
// ---------------------------------------------------------------------

export interface KVNamespace {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

export interface CloudflareExecutionContext {
  waitUntil(p: Promise<unknown>): void
}

/**
 * The subset of `IncomingRequestCfProperties` this adapter reads. Every
 * field is optional: `request.cf` is undefined in local `wrangler dev` and
 * on non-proxied requests.
 */
export interface CloudflareRequestProperties {
  country?: string | null
  city?: string | null
  region?: string | null
  continent?: string | null
  postalCode?: string | null
  timezone?: string | null
  latitude?: string | null
  longitude?: string | null
  colo?: string | null
  asn?: number | null
}

/** A Workers `Request`, which carries the `cf` property. */
export type CloudflareRequest = Request & { cf?: CloudflareRequestProperties }

// ---------------------------------------------------------------------
// KV-backed storage.
//
// FRESHNESS vs RETENTION: the KV TTL below is RETENTION only, so KV does
// not accumulate datafiles for keys nobody uses any more. Whether a stored
// copy is fresh enough to serve is decided by the client's `cacheTtlMs`
// (default 5 minutes), uniformly across all seven runtimes. That split is
// what makes the degraded path reachable: an entry past its freshness
// window is still readable, so a failed refresh can serve it with
// `degraded: true` instead of nothing at all.
// ---------------------------------------------------------------------

/** Retention floor. Cloudflare rejects an `expirationTtl` below 60 seconds. */
const MIN_KV_TTL_SECONDS = 60

const DEFAULT_KV_RETENTION_SECONDS = 24 * 60 * 60

export function createKVStorageAdapter(
  kv: KVNamespace,
  retentionSeconds: number = DEFAULT_KV_RETENTION_SECONDS,
): UnifiedStorageAdapter {
  const expirationTtl = Math.max(MIN_KV_TTL_SECONDS, Math.floor(retentionSeconds))

  return {
    // Sticky bucketing is not implemented on this adapter. A Worker isolate
    // is stateless per request, and a KV read per evaluation would add a
    // round trip to the hot path; the evaluator's hashing is already
    // deterministic for a given visitor, so bucketing is stable without it.
    stickyLookup(): StickyAssignment | null {
      return null
    },
    stickySave(): void {
      // Deliberate no-op, see stickyLookup.
    },

    async datafileGet(sdkKey: string) {
      const raw = await kv.get(`avsb:df:${sdkKey}`)
      if (!raw) return null
      try {
        return JSON.parse(raw) as { datafile: FlagDatafile; cachedAt: number }
      } catch {
        // A value we cannot parse is treated as a miss: the next fetch
        // overwrites it.
        return null
      }
    },

    async datafileSet(sdkKey: string, datafile: FlagDatafile) {
      const blob = JSON.stringify({ datafile, cachedAt: Date.now() })
      await kv.put(`avsb:df:${sdkKey}`, blob, { expirationTtl })
    },

    isHealthy: () => true,
  }
}

// ---------------------------------------------------------------------
// contextFrom
// ---------------------------------------------------------------------

/** Read Cloudflare's own geo for this request. */
export function cloudflareGeo(req: CloudflareRequest): EdgeGeo {
  const cf = req.cf
  return {
    country: cf?.country ?? req.headers.get('cf-ipcountry') ?? undefined,
    region: cf?.region ?? undefined,
    city: cf?.city ?? undefined,
    continent: cf?.continent ?? undefined,
    postalCode: cf?.postalCode ?? undefined,
    timezone: cf?.timezone ?? undefined,
    latitude: toFiniteNumber(cf?.latitude ?? undefined),
    longitude: toFiniteNumber(cf?.longitude ?? undefined),
  }
}

/**
 * The context this adapter binds when no `contextFrom` is supplied. Exported
 * so a custom `contextFrom` can extend it instead of starting from nothing.
 */
export function cloudflareContextFrom(req: CloudflareRequest): SingleContext {
  return buildRequestContext({
    visitorId: readVisitorId(req.headers),
    headers: req.headers,
    url: req.url,
    geo: cloudflareGeo(req),
    extra: {
      colo: req.cf?.colo ?? undefined,
      asn: req.cf?.asn ?? undefined,
    },
  })
}

// ---------------------------------------------------------------------
// createCloudflareHandler
// ---------------------------------------------------------------------

export interface CloudflareHandlerOptions<TEnv = Record<string, unknown>> {
  /** Environment SDK key, or a function of `env` that returns it. */
  sdkKey: FromEnv<TEnv, string>
  /**
   * Your application handler. The client is initialised and bound to the
   * request context, so `client.getBoolFlag('key', false)` needs no context
   * argument.
   */
  handler: (
    req: CloudflareRequest,
    client: AvsbEdgeClient,
    env: TEnv,
    ctx: CloudflareExecutionContext,
  ) => Promise<Response>
  /**
   * Evaluation context for this request. Optional: the default reads the
   * visitor id and Cloudflare's geo, see `cloudflareContextFrom`.
   */
  contextFrom?: (req: CloudflareRequest, env: TEnv) => EvalContext | undefined
  /** KV namespace for cross-request datafile caching, or a function of `env`. */
  kv?: FromEnv<TEnv, KVNamespace | undefined>
  /** How long KV keeps a datafile at all. Default 24h, minimum 60s. */
  kvRetentionSeconds?: number
  /** Any client option the adapter does not derive from the request. */
  clientOptions?: AdapterClientOptions
}

/**
 * Returns a Cloudflare Workers `fetch` handler.
 *
 * @example
 * ```ts
 * import { createCloudflareHandler } from '@avsbhq/edge/cloudflare'
 *
 * interface Env {
 *   AVSB_SDK_KEY: string
 *   AVSB_KV: KVNamespace
 * }
 *
 * export default {
 *   fetch: createCloudflareHandler<Env>({
 *     sdkKey: (env) => env.AVSB_SDK_KEY,
 *     kv: (env) => env.AVSB_KV,
 *     handler: async (req, client) => {
 *       const flag = client.getBoolFlag('new-checkout', false)
 *       return Response.json({ enabled: flag.isEnabled() })
 *     },
 *   }),
 * }
 * ```
 */
export function createCloudflareHandler<TEnv = Record<string, unknown>>(
  opts: CloudflareHandlerOptions<TEnv>,
): (
  req: CloudflareRequest,
  env: TEnv,
  ctx: CloudflareExecutionContext,
) => Promise<Response> {
  return async (req, env, ctx) => {
    const kv = opts.kv ? resolveFromEnv(opts.kv, env) : undefined
    const storage = kv ? createKVStorageAdapter(kv, opts.kvRetentionSeconds) : undefined

    const client = new AvsbEdgeClient({
      ...opts.clientOptions,
      sdkKey: resolveFromEnv(opts.sdkKey, env),
      context: opts.contextFrom ? opts.contextFrom(req, env) : cloudflareContextFrom(req),
      pageUrl: req.url,
      storage,
      waitUntil: (p) => ctx.waitUntil(p),
    })

    await client.init()

    const response = await opts.handler(req, client, env, ctx)

    // Fire and forget: events, the cache write, and the heartbeat all
    // complete after the response has been returned.
    ctx.waitUntil(client.flushEvents())

    return response
  }
}
