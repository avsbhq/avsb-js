// =====================================================================
// @avsbhq/edge/deno — Deno Deploy / Deno.serve adapter.
//
// Types are declared structurally, so there is no dependency on Deno's
// type definitions and this file compiles in a plain TypeScript build.
//
// WHAT contextFrom EXTRACTS on Deno:
//
//   key        `x-avsb-visitor-id` header, then the snippet's
//              `_avsb_visitor` cookie. Never the IP.
//   geo        NONE. Deno Deploy does not inject geo headers or expose a
//              location object, so this adapter does not invent one. Two
//              honest ways to get geo here: put Deno Deploy behind a CDN
//              that adds geo headers and read them in your own
//              `contextFrom`, or look the IP up yourself. The default
//              returns a context with no geo attributes rather than empty
//              strings, so an `exists` audience condition can tell the
//              difference.
//   extra      `region`, when `Deno.env.get('DENO_REGION')` is readable.
//              Deno Deploy sets it; a local `deno run` without
//              `--allow-env` does not, and a permission error is caught.
//   page       url, path, host from the request URL; referrer, userAgent,
//              language from headers.
//
// Deno Deploy has no `waitUntil`, so `flushEvents()` is awaited before the
// response is returned.
// =====================================================================

import type { EvalContext, FlagDatafile, SingleContext, StickyAssignment } from '@avsbhq/core'
import type { UnifiedStorageAdapter } from '@avsbhq/utils'
import { AvsbEdgeClient } from '../AvsbEdgeClient'
import type { AdapterClientOptions } from '../types'
import { buildRequestContext, readVisitorId } from '../requestContext'

// ---------------------------------------------------------------------
// Structural Deno surfaces.
// ---------------------------------------------------------------------

export interface DenoKVEntry {
  value: unknown
}

export interface DenoKV {
  get(key: string[]): Promise<DenoKVEntry | null>
  set(key: string[], value: unknown): Promise<unknown>
}

/** Second argument `Deno.serve` hands the handler. */
export interface DenoServeInfo {
  remoteAddr?: { hostname?: string; port?: number; transport?: string }
}

// ---------------------------------------------------------------------
// Deno KV-backed storage. Retention is Deno KV's own (an entry lives until
// overwritten); freshness is the client's `cacheTtlMs`.
// ---------------------------------------------------------------------

export function createDenoKVAdapter(kv: DenoKV): UnifiedStorageAdapter {
  return {
    stickyLookup(): StickyAssignment | null {
      return null
    },
    stickySave(): void {
      // Deliberate no-op: Deno KV writes are async and the evaluator's
      // hashing is already stable per visitor.
    },

    async datafileGet(sdkKey: string) {
      try {
        const entry = await kv.get(['avsb', 'df', sdkKey])
        const value = entry?.value
        if (!value || typeof value !== 'object') return null
        const candidate = value as { datafile?: unknown; cachedAt?: unknown }
        if (!candidate.datafile || typeof candidate.datafile !== 'object') return null
        return {
          datafile: candidate.datafile as FlagDatafile,
          cachedAt: typeof candidate.cachedAt === 'number' ? candidate.cachedAt : Date.now(),
        }
      } catch {
        return null
      }
    },

    async datafileSet(sdkKey: string, datafile: FlagDatafile) {
      await kv.set(['avsb', 'df', sdkKey], { datafile, cachedAt: Date.now() })
    },

    isHealthy: () => true,
  }
}

// ---------------------------------------------------------------------
// contextFrom
// ---------------------------------------------------------------------

/**
 * Deno Deploy's region, when the environment is readable. Returns undefined
 * rather than throwing when `--allow-env` was not granted.
 */
export function denoRegion(): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get?: (k: string) => string | undefined } } }).Deno
  try {
    const value = deno?.env?.get?.('DENO_REGION')
    return value && value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The context this adapter binds when no `contextFrom` is supplied. Exported
 * so a custom `contextFrom` can extend it, which is the documented way to
 * add geo on this runtime.
 */
export function denoContextFrom(req: Request): SingleContext {
  return buildRequestContext({
    visitorId: readVisitorId(req.headers),
    headers: req.headers,
    url: req.url,
    extra: { region: denoRegion() },
  })
}

// ---------------------------------------------------------------------
// createDenoHandler
// ---------------------------------------------------------------------

export interface DenoHandlerOptions {
  sdkKey: string
  handler: (req: Request, client: AvsbEdgeClient) => Promise<Response>
  /** Optional: the default reads the visitor id. Deno exposes no geo. */
  contextFrom?: (req: Request, info?: DenoServeInfo) => EvalContext | undefined
  /** Deno KV instance, from `await Deno.openKv()`. */
  kv?: DenoKV
  clientOptions?: AdapterClientOptions
}

/**
 * Returns a `Deno.serve` request handler.
 *
 * @example
 * ```ts
 * import { createDenoHandler } from '@avsbhq/edge/deno'
 *
 * const kv = await Deno.openKv()
 *
 * Deno.serve(
 *   createDenoHandler({
 *     sdkKey: Deno.env.get('AVSB_SDK_KEY') ?? '',
 *     kv,
 *     handler: async (req, client) => {
 *       const flag = client.getBoolFlag('dark-mode', false)
 *       return Response.json({ darkMode: flag.value })
 *     },
 *   })
 * )
 * ```
 */
export function createDenoHandler(
  opts: DenoHandlerOptions,
): (req: Request, info?: DenoServeInfo) => Promise<Response> {
  const storage = opts.kv ? createDenoKVAdapter(opts.kv) : undefined

  return async (req, info) => {
    const client = new AvsbEdgeClient({
      ...opts.clientOptions,
      sdkKey: opts.sdkKey,
      context: opts.contextFrom ? opts.contextFrom(req, info) : denoContextFrom(req),
      pageUrl: req.url,
      storage,
    })

    await client.init()

    const response = await opts.handler(req, client)

    // Deno Deploy has no waitUntil: awaiting is the only way the batch, the
    // heartbeat, and the cache write actually leave the isolate.
    await client.flushEvents()

    return response
  }
}
