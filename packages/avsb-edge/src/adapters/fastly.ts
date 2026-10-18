// =====================================================================
// @avsbhq/edge/fastly — Fastly Compute adapter.
//
// Types are declared structurally, so there is no dependency on
// `@fastly/js-compute`.
//
// WHAT contextFrom EXTRACTS on Fastly:
//
//   key        `x-avsb-visitor-id` header, then the snippet's
//              `_avsb_visitor` cookie. Never the IP.
//   geo        `event.client.geo`, when the runtime supplies it: Fastly's
//              geolocation fields are snake_case (`country_code`,
//              `postal_code`), and they are mapped to the shared attribute
//              names here so an audience on `country` matches the same way
//              it does on every other runtime. Every field is optional, so
//              a runtime that does not expose `client.geo` simply produces
//              a context with no geo rather than failing.
//   page       url, path, host from the request URL; referrer, userAgent,
//              language from headers.
//
// TWO FASTLY CONSTRAINTS THIS SHAPE EXISTS FOR:
//
//   1. The handler takes the whole FETCH EVENT, not just the request,
//      because geo and the client address hang off `event.client`. Taking
//      only the request (what this adapter used to do) made geo targeting
//      impossible on Fastly.
//   2. `kvStore` accepts a thunk, because Fastly forbids constructing
//      platform resources during global initialisation: `new KVStore(...)`
//      has to run inside the handler.
//
// Fastly Compute has no `waitUntil`, so `flushEvents()` is awaited before
// the response is returned.
// =====================================================================

import type { EvalContext, FlagDatafile, SingleContext, StickyAssignment } from '@avsbhq/core'
import type { UnifiedStorageAdapter } from '@avsbhq/utils'
import { AvsbEdgeClient } from '../AvsbEdgeClient'
import type { AdapterClientOptions } from '../types'
import { resolveLazy, type Lazy } from '../fromEnv'
import {
  buildRequestContext,
  readVisitorId,
  toFiniteNumber,
  type EdgeGeo,
} from '../requestContext'

// ---------------------------------------------------------------------
// Structural Fastly surfaces. Every field optional on purpose: this is a
// description of what we read, not a claim about what the platform emits.
// ---------------------------------------------------------------------

export interface FastlyKVStoreEntry {
  text?: () => Promise<string>
  body?: ReadableStream<Uint8Array>
}

export interface FastlyKVStore {
  get(key: string): Promise<FastlyKVStoreEntry | null>
  put(key: string, value: string): Promise<unknown>
}

/** Fastly's geolocation record, in its own snake_case vocabulary. */
export interface FastlyGeolocation {
  country_code?: string | null
  region?: string | null
  city?: string | null
  continent?: string | null
  postal_code?: string | null
  latitude?: number | null
  longitude?: number | null
}

export interface FastlyClientInfo {
  address?: string | null
  geo?: FastlyGeolocation | null
}

/** The `FetchEvent` shape this adapter consumes. */
export interface FastlyFetchEvent {
  request: Request
  client?: FastlyClientInfo
}

// ---------------------------------------------------------------------
// KV Store-backed storage. Retention is Fastly's own (a KV Store entry
// lives until overwritten); freshness is the client's `cacheTtlMs`.
// ---------------------------------------------------------------------

export function createFastlyKVAdapter(kv: FastlyKVStore): UnifiedStorageAdapter {
  return {
    stickyLookup(): StickyAssignment | null {
      return null
    },
    stickySave(): void {
      // Deliberate no-op: a KV round trip per evaluation would sit on the
      // hot path, and the evaluator's hashing is already stable per visitor.
    },

    async datafileGet(sdkKey: string) {
      try {
        const entry = await kv.get(`avsb_df_${sdkKey}`)
        if (!entry) return null
        const raw = await readEntry(entry)
        if (!raw) return null
        return JSON.parse(raw) as { datafile: FlagDatafile; cachedAt: number }
      } catch {
        // A miss, a malformed value, or a KV outage are the same to the
        // caller: no cached copy. The client logs the fetch that follows.
        return null
      }
    },

    async datafileSet(sdkKey: string, datafile: FlagDatafile) {
      const blob = JSON.stringify({ datafile, cachedAt: Date.now() })
      await kv.put(`avsb_df_${sdkKey}`, blob)
    },

    isHealthy: () => true,
  }
}

/** Prefer `entry.text()`; fall back to draining `entry.body`. */
async function readEntry(entry: FastlyKVStoreEntry): Promise<string | null> {
  if (typeof entry.text === 'function') return entry.text()
  if (entry.body) return streamToString(entry.body)
  return null
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

// ---------------------------------------------------------------------
// contextFrom
// ---------------------------------------------------------------------

/** Map Fastly's snake_case geolocation onto the shared attribute names. */
export function fastlyGeo(client: FastlyClientInfo | undefined): EdgeGeo {
  const geo = client?.geo
  if (!geo) return {}
  return {
    country: geo.country_code ?? undefined,
    region: geo.region ?? undefined,
    city: geo.city ?? undefined,
    continent: geo.continent ?? undefined,
    postalCode: geo.postal_code ?? undefined,
    latitude: toFiniteNumber(geo.latitude ?? undefined),
    longitude: toFiniteNumber(geo.longitude ?? undefined),
  }
}

/**
 * The context this adapter binds when no `contextFrom` is supplied. Exported
 * so a custom `contextFrom` can extend it.
 */
export function fastlyContextFrom(event: FastlyFetchEvent): SingleContext {
  return buildRequestContext({
    visitorId: readVisitorId(event.request.headers),
    headers: event.request.headers,
    url: event.request.url,
    geo: fastlyGeo(event.client),
  })
}

// ---------------------------------------------------------------------
// createFastlyHandler
// ---------------------------------------------------------------------

export interface FastlyHandlerOptions {
  sdkKey: string
  handler: (req: Request, client: AvsbEdgeClient) => Promise<Response>
  /** Optional: the default reads the visitor id and `event.client.geo`. */
  contextFrom?: (event: FastlyFetchEvent) => EvalContext | undefined
  /**
   * KV Store for datafile caching. Pass a thunk (`() => new KVStore('name')`)
   * so the store is constructed inside the request, which Fastly requires.
   */
  kvStore?: Lazy<FastlyKVStore | undefined>
  clientOptions?: AdapterClientOptions
}

/**
 * Returns a Fastly Compute fetch-event handler.
 *
 * @example
 * ```ts
 * /// <reference types="@fastly/js-compute" />
 * import { createFastlyHandler } from '@avsbhq/edge/fastly'
 * import { KVStore } from 'fastly:kv-store'
 *
 * const avsb = createFastlyHandler({
 *   sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
 *   kvStore: () => new KVStore('avsb-datafiles'),
 *   handler: async (req, client) => {
 *     const flag = client.getBoolFlag('new-checkout', false)
 *     return Response.json({ enabled: flag.isEnabled() })
 *   },
 * })
 *
 * addEventListener('fetch', (event) => event.respondWith(avsb(event)))
 * ```
 */
export function createFastlyHandler(
  opts: FastlyHandlerOptions,
): (event: FastlyFetchEvent) => Promise<Response> {
  return async (event) => {
    const kv = opts.kvStore ? resolveLazy(opts.kvStore) : undefined
    const storage = kv ? createFastlyKVAdapter(kv) : undefined

    const client = new AvsbEdgeClient({
      ...opts.clientOptions,
      sdkKey: opts.sdkKey,
      context: opts.contextFrom ? opts.contextFrom(event) : fastlyContextFrom(event),
      pageUrl: event.request.url,
      storage,
      // Fastly has no waitUntil: deferred work is awaited below instead.
    })

    await client.init()

    const response = await opts.handler(event.request, client)

    // Awaited, not fire-and-forget: Fastly ends the instance with the
    // response, so an unawaited flush is a dropped batch.
    await client.flushEvents()

    return response
  }
}
