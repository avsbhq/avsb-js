// =====================================================================
// @avsbhq/edge/vercel — Vercel Edge Functions adapter.
//
// Types are declared structurally, so there is no dependency on
// `@vercel/edge-config` or `@vercel/functions`.
//
// WHAT contextFrom EXTRACTS on Vercel:
//
//   key        `x-avsb-visitor-id` header, then the snippet's
//              `_avsb_visitor` cookie. Never the IP.
//   geo        the `x-vercel-ip-*` request headers Vercel adds at the edge:
//              country, country-region, city, latitude, longitude,
//              timezone. City arrives percent-encoded ("San%20Francisco"),
//              so it is decoded here.
//   page       url, path, host from the request URL; referrer, userAgent,
//              language from headers.
//
// THE BUG THIS FILE HAD (report 02 §5.13): the Edge Config storage adapter
// cached the datafile in a module-level Map with NO expiry, and `datafileSet`
// wrote only to that Map, so a warm isolate served one datafile forever. It
// now carries a retention bound, and freshness is decided by the client's
// `cacheTtlMs` like every other runtime.
// =====================================================================

import type { EvalContext, FlagDatafile, SingleContext, StickyAssignment } from '@avsbhq/core'
import type { UnifiedStorageAdapter } from '@avsbhq/utils'
import { AvsbEdgeClient } from '../AvsbEdgeClient'
import type { AdapterClientOptions } from '../types'
import {
  buildRequestContext,
  readVisitorId,
  toFiniteNumber,
  type EdgeGeo,
} from '../requestContext'

// ---------------------------------------------------------------------
// Structural Vercel surfaces.
// ---------------------------------------------------------------------

/** The one method this adapter uses from an Edge Config client. */
export interface VercelEdgeConfig {
  get(key: string): Promise<unknown>
}

/** Matches `NextFetchEvent` and the `waitUntil` from `@vercel/functions`. */
export interface VercelWaitUntil {
  waitUntil(p: Promise<unknown>): void
}

// ---------------------------------------------------------------------
// Edge Config-backed storage.
//
// Edge Config is READ-ONLY at runtime: writes go through the Vercel API,
// out of band. So `datafileSet` can only warm the in-process map, and a
// deployment that wants a shared cache populates the Edge Config key
// `avsb_df_<sdkKey>` from CI or a cron.
//
// The map is process memory with a RETENTION bound so a long-lived isolate
// cannot pin one datafile forever. Freshness is the client's `cacheTtlMs`.
// ---------------------------------------------------------------------

const DEFAULT_MEMORY_RETENTION_MS = 60 * 60 * 1000

interface CacheEntry {
  datafile: FlagDatafile
  cachedAt: number
}

export function createEdgeConfigAdapter(
  edgeConfig?: VercelEdgeConfig,
  retentionMs: number = DEFAULT_MEMORY_RETENTION_MS,
): UnifiedStorageAdapter {
  // Module-scope would leak between two clients configured with different
  // Edge Configs in one deployment, so the map is per adapter instance. The
  // adapter itself is created once per handler, not once per request.
  const memCache = new Map<string, CacheEntry>()

  return {
    // See the Cloudflare adapter: sticky bucketing would add a round trip to
    // every evaluation, and the evaluator's hashing is already stable per
    // visitor.
    stickyLookup(): StickyAssignment | null {
      return null
    },
    stickySave(): void {
      // Deliberate no-op: Edge Config is read-only at runtime.
    },

    async datafileGet(sdkKey: string) {
      const mem = memCache.get(sdkKey)
      if (mem) {
        if (Date.now() - mem.cachedAt <= retentionMs) return mem
        memCache.delete(sdkKey)
      }

      if (!edgeConfig) return null
      try {
        const raw = await edgeConfig.get(`avsb_df_${sdkKey}`)
        const parsed = parseEdgeConfigValue(raw)
        if (!parsed) return null
        memCache.set(sdkKey, parsed)
        return parsed
      } catch {
        // A missing key, a malformed value, or an Edge Config outage all mean
        // the same thing to the caller: no cached copy. The client logs the
        // network fetch that follows.
        return null
      }
    },

    async datafileSet(sdkKey: string, datafile: FlagDatafile) {
      memCache.set(sdkKey, { datafile, cachedAt: Date.now() })
    },

    isHealthy: () => true,
  }
}

/**
 * Edge Config values are JSON, so a stored datafile arrives either as a
 * string (when it was written as one) or already parsed. Both are accepted.
 */
function parseEdgeConfigValue(raw: unknown): CacheEntry | null {
  const value: unknown = typeof raw === 'string' ? safeJsonParse(raw) : raw
  if (!value || typeof value !== 'object') return null
  const candidate = value as { datafile?: unknown; cachedAt?: unknown }
  if (!candidate.datafile || typeof candidate.datafile !== 'object') return null
  return {
    datafile: candidate.datafile as FlagDatafile,
    // A value written without a timestamp is treated as brand new rather than
    // as epoch zero, which would make it permanently stale.
    cachedAt: typeof candidate.cachedAt === 'number' ? candidate.cachedAt : Date.now(),
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------
// contextFrom
// ---------------------------------------------------------------------

/** Vercel percent-encodes city names in its geo headers. */
function decodeHeader(value: string | null): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Read Vercel's `x-vercel-ip-*` geo headers for this request. */
export function vercelGeo(req: Request): EdgeGeo {
  const h = req.headers
  return {
    country: h.get('x-vercel-ip-country') ?? undefined,
    region: h.get('x-vercel-ip-country-region') ?? undefined,
    city: decodeHeader(h.get('x-vercel-ip-city')),
    timezone: h.get('x-vercel-ip-timezone') ?? undefined,
    latitude: toFiniteNumber(h.get('x-vercel-ip-latitude')),
    longitude: toFiniteNumber(h.get('x-vercel-ip-longitude')),
  }
}

/**
 * The context this adapter binds when no `contextFrom` is supplied. Exported
 * so a custom `contextFrom` can extend it.
 */
export function vercelContextFrom(req: Request): SingleContext {
  return buildRequestContext({
    visitorId: readVisitorId(req.headers),
    headers: req.headers,
    url: req.url,
    geo: vercelGeo(req),
  })
}

// ---------------------------------------------------------------------
// createVercelHandler
// ---------------------------------------------------------------------

export interface VercelHandlerOptions {
  sdkKey: string
  handler: (req: Request, client: AvsbEdgeClient) => Promise<Response>
  /** Optional: the default reads the visitor id and Vercel's geo headers. */
  contextFrom?: (req: Request) => EvalContext | undefined
  /** Edge Config client, e.g. `createClient(process.env.EDGE_CONFIG)`. */
  edgeConfig?: VercelEdgeConfig
  /** How long the in-process copy is kept at all. Default 1h. */
  memoryRetentionMs?: number
  clientOptions?: AdapterClientOptions
}

/**
 * Returns a Vercel Edge Function handler.
 *
 * @example
 * ```ts
 * import { createVercelHandler } from '@avsbhq/edge/vercel'
 * import { createClient } from '@vercel/edge-config'
 *
 * export const runtime = 'edge'
 *
 * const handler = createVercelHandler({
 *   sdkKey: process.env.AVSB_SDK_KEY ?? '',
 *   edgeConfig: createClient(process.env.EDGE_CONFIG),
 *   handler: async (req, client) => {
 *     const flag = client.getStringFlag('homepage-hero', 'control')
 *     return Response.json({ variant: flag.value })
 *   },
 * })
 *
 * export function GET(req: Request): Promise<Response> {
 *   return handler(req)
 * }
 * ```
 */
export function createVercelHandler(
  opts: VercelHandlerOptions,
): (req: Request, ctx?: VercelWaitUntil) => Promise<Response> {
  // Built once per handler, not per request, so the in-process cache is
  // actually warm across requests to the same isolate.
  const storage = createEdgeConfigAdapter(opts.edgeConfig, opts.memoryRetentionMs)

  return async (req, ctx) => {
    const client = new AvsbEdgeClient({
      ...opts.clientOptions,
      sdkKey: opts.sdkKey,
      context: opts.contextFrom ? opts.contextFrom(req) : vercelContextFrom(req),
      pageUrl: req.url,
      storage,
      waitUntil: ctx ? (p) => ctx.waitUntil(p) : undefined,
    })

    await client.init()

    const response = await opts.handler(req, client)

    if (ctx) {
      ctx.waitUntil(client.flushEvents())
    } else {
      // No FetchEvent was passed (a plain route handler). Awaiting the flush
      // costs the request a few ms but is the only way the events, the
      // heartbeat, and the cache write survive the function freezing.
      await client.flushEvents()
    }

    return response
  }
}
