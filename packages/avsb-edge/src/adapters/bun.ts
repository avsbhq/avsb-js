// =====================================================================
// @avsbhq/edge/bun — Bun.serve adapter.
//
// Types are declared structurally, so there is no dependency on
// `bun-types`.
//
// WHAT contextFrom EXTRACTS on Bun:
//
//   key        `x-avsb-visitor-id` header, then the snippet's
//              `_avsb_visitor` cookie. Never the IP.
//   geo        NONE. Bun is a runtime, not a network: there is no
//              IP-derived location to read. Behind a proxy that adds geo
//              headers (Cloudflare, a load balancer), read them in your own
//              `contextFrom`. The default omits geo attributes entirely
//              rather than writing empty strings.
//   page       url, path, host from the request URL; referrer, userAgent,
//              language from headers.
//
// Bun has a persistent process, so the datafile cache is a process-memory
// map shared by every request. It carries a RETENTION bound so a
// long-running server cannot pin one datafile forever; whether a stored copy
// is fresh enough to serve is the client's `cacheTtlMs`, as on every other
// runtime.
//
// Bun has no `waitUntil`. Its event loop does outlive the response, so the
// flush is started without blocking and its failure is reported by the
// client's logger.
// =====================================================================

import type { EvalContext, FlagDatafile, SingleContext, StickyAssignment } from '@avsbhq/core'
import type { UnifiedStorageAdapter } from '@avsbhq/utils'
import { AvsbEdgeClient } from '../AvsbEdgeClient'
import type { AdapterClientOptions } from '../types'
import { buildRequestContext, readVisitorId } from '../requestContext'

const DEFAULT_MEMORY_RETENTION_MS = 60 * 60 * 1000

interface CacheEntry {
  datafile: FlagDatafile
  cachedAt: number
}

/** Second argument `Bun.serve` hands the fetch handler. */
export interface BunServer {
  requestIP?: (req: Request) => { address?: string; family?: string; port?: number } | null
}

/**
 * Process-memory datafile cache.
 *
 * Created per handler rather than at module scope, so two servers in one
 * process (a test suite spinning up several) do not share one map keyed only
 * by sdkKey.
 */
export function createBunMemoryAdapter(
  retentionMs: number = DEFAULT_MEMORY_RETENTION_MS,
): UnifiedStorageAdapter {
  const cache = new Map<string, CacheEntry>()

  return {
    stickyLookup(): StickyAssignment | null {
      return null
    },
    stickySave(): void {
      // Deliberate no-op. A process-memory sticky store would not survive a
      // restart or match a second instance, so it would create the illusion
      // of stickiness rather than the property.
    },

    async datafileGet(sdkKey: string) {
      const entry = cache.get(sdkKey)
      if (!entry) return null
      if (Date.now() - entry.cachedAt > retentionMs) {
        cache.delete(sdkKey)
        return null
      }
      return entry
    },

    async datafileSet(sdkKey: string, datafile: FlagDatafile) {
      cache.set(sdkKey, { datafile, cachedAt: Date.now() })
    },

    isHealthy: () => true,
  }
}

/**
 * The context this adapter binds when no `contextFrom` is supplied. Exported
 * so a custom `contextFrom` can extend it.
 */
export function bunContextFrom(req: Request): SingleContext {
  return buildRequestContext({
    visitorId: readVisitorId(req.headers),
    headers: req.headers,
    url: req.url,
  })
}

// ---------------------------------------------------------------------
// createBunHandler
// ---------------------------------------------------------------------

export interface BunHandlerOptions {
  sdkKey: string
  handler: (req: Request, client: AvsbEdgeClient) => Promise<Response>
  /** Optional: the default reads the visitor id. Bun exposes no geo. */
  contextFrom?: (req: Request, server?: BunServer) => EvalContext | undefined
  /** How long the process cache keeps a datafile at all. Default 1h. */
  memoryRetentionMs?: number
  clientOptions?: AdapterClientOptions
}

/**
 * Returns a `Bun.serve` fetch handler.
 *
 * @example
 * ```ts
 * import { createBunHandler } from '@avsbhq/edge/bun'
 *
 * Bun.serve({
 *   port: 3000,
 *   fetch: createBunHandler({
 *     sdkKey: Bun.env.AVSB_SDK_KEY ?? '',
 *     handler: async (req, client) => {
 *       const limit = client.getNumberFlag('page-size', 25)
 *       return Response.json({ pageSize: limit.value })
 *     },
 *   }),
 * })
 * ```
 */
export function createBunHandler(
  opts: BunHandlerOptions,
): (req: Request, server?: BunServer) => Promise<Response> {
  const storage = createBunMemoryAdapter(opts.memoryRetentionMs)

  return async (req, server) => {
    const client = new AvsbEdgeClient({
      ...opts.clientOptions,
      sdkKey: opts.sdkKey,
      context: opts.contextFrom ? opts.contextFrom(req, server) : bunContextFrom(req),
      pageUrl: req.url,
      storage,
    })

    await client.init()

    const response = await opts.handler(req, client)

    // Bun's loop outlives the response, so this does not need awaiting. The
    // client already logs a failed send; `void` documents that the promise is
    // deliberately unhandled rather than forgotten.
    void client.flushEvents()

    return response
  }
}
