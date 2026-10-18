// =====================================================================
// Data-plane endpoint contract (SDK/API DX overhaul spec §1.1).
//
// SINGLE SOURCE OF TRUTH for every network target an A vs B SDK talks
// to. Browser, node, edge, and utils read their hosts and paths from
// here.
//
// The rule, precisely: anything that DIALS a data-plane target composes
// its URL through this module, and nothing reaches a host by string
// surgery on another host (the `cdn.` → `app.` replace in AvsbClient.ts
// and the hardcoded stream host in AvsbServer.ts are the bugs this
// module exists to delete). The publisher side is the one exception:
// `app/_lib/flagDatafile.ts` writes its own app-route literals for
// `heartbeatEndpoint` and `streamEndpoint` because the app cannot import
// a published package, and those two literals are pinned by
// app/_lib/flagDatafile.test.ts instead.
//
// The same constants are mirrored per language in:
//   packages/avsb-python/src/avsb/endpoints.py
//   packages/avsb-go/endpoints.go
//   packages/avsb-ruby/lib/avsb/endpoints.rb
//   packages/avsb-php/src/Avsbhq/Avsb/Endpoints.php
//   packages/avsb-java/src/main/java/cloud/avsb/sdk/Endpoints.java
//   packages/avsb-dotnet/src/Avsb.SDK/Endpoints.cs
//
// Every one of those ports, and this module, is locked by the
// `endpoints` conformance fixture family
// (packages/avsb-conformance/fixtures/endpoints/manifest.json). Change
// a URL here and the fixture must change with it, in the same commit,
// or every SDK's conformance run fails.
//
// Credential posture (one map, documented at
// content/docs/developer-reference/data-plane-endpoints.mdx):
//   - Datafile and preview reads are KEYLESS BY PATH. The sdk key is the
//     path segment; no header, no query string, no Authorization.
//   - Event sends carry `sdkKey` in the JSON body envelope, because the
//     collect paths are shared by every key.
//   - The stream ticket is the one data-plane read that takes the key as
//     a query parameter, because EventSource cannot set headers.
//   - No `Authorization` header anywhere on the data plane.
// =====================================================================

// ---------------------------------------------------------------------
// Default hosts.
//
// A caller may override any of these (self-hosted proxy, local dev,
// test double). Nothing here points at a host that does not exist:
// `stream.avsb.cloud` and `datafile.avsb.cloud` are NOT real and must
// never appear as a default anywhere.
// ---------------------------------------------------------------------

/** Datafile + preview + static SDK asset CDN (Cloudflare Worker over R2). */
export const DEFAULT_CDN_HOST = 'https://cdn.avsb.cloud'

/** Event ingestion worker. Origin only: the collect paths are appended. */
export const DEFAULT_COLLECT_HOST = 'https://ingest.avsb.cloud'

/** Dashboard app origin. Serves the stream ticket and heartbeat routes. */
export const DEFAULT_APP_HOST = 'https://app.avsb.cloud'

// ---------------------------------------------------------------------
// Paths.
// ---------------------------------------------------------------------

/**
 * Every ingestion path, keyed by what it carries. Values are absolute
 * paths appended to a collect ORIGIN (see `collectUrl`).
 */
export const COLLECT_PATHS = {
  /** One event, one request. Used by the snippet's sendBeacon fallback. */
  single: '/v1/collect',
  /** Exposure batch: `{sdkKey, events: [...]}`. */
  batch: '/v1/collect/batch',
  /** Metric/conversion batch: `{sdkKey, metricEvents: [...]}`. */
  metricBatch: '/v1/collect/metric-batch',
  /** Purchase batch: `{sdkKey, orders: [...]}`. */
  orders: '/v1/collect/orders',
  /** Aggregated client error reports: `{sdkKey, errors: [...]}`. */
  errors: '/v1/collect/errors',
  /** Install-detection ping. Rate limited per IP, not per key. */
  ping: '/v1/ping',
  /** Coarse geo lookup for audience targeting. GET, no body. */
  geo: '/v1/geo',
} as const

export type CollectPathKey = keyof typeof COLLECT_PATHS

/** Stream TICKET path on the app origin. Mints a short-lived SSE token. */
export const STREAM_TICKET_PATH = '/api/sdk/stream'

/** SDK liveness path on the app origin. */
export const HEARTBEAT_PATH = '/api/sdk/heartbeat'

/** Object name of the live datafile under the `<sdkKey>/` CDN prefix. */
export const DATAFILE_FILENAME = 'datafile.json'

/** Object name of the throwaway preview snapshot. Never cached. */
export const PREVIEW_FILENAME = 'preview.json'

// ---------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------

function trimTrailingSlashes(host: string): string {
  return host.replace(/\/+$/, '')
}

/**
 * Loud guard. An empty key composes `https://cdn.avsb.cloud//datafile.json`,
 * which 404s at the edge with nothing in the message to explain why. Full
 * key-SHAPE validation (`sdk_<envKey>_<cuid2>`) belongs to each SDK's
 * constructor per spec §1.2; this only catches "nothing was passed".
 */
function requireSdkKey(sdkKey: string, fnName: string): string {
  const trimmed = sdkKey.trim()
  if (!trimmed) {
    throw new TypeError(
      `${fnName} was called without an SDK key. Pass the environment SDK key ` +
        `(it looks like "sdk_production_xxxxxxxx"), which you can copy from ` +
        `Environments in the project sidebar, in the A vs B dashboard.`,
    )
  }
  return trimmed
}

// ---------------------------------------------------------------------
// Datafile + preview.
// ---------------------------------------------------------------------

/**
 * Canonical datafile URL: `{cdnHost}/{sdkKey}/datafile.json`.
 *
 * This is the ONLY correct shape. Every other form in the tree was a
 * bug (`/datafiles/{key}.json`, `/v1/datafiles/{key}.json`,
 * `datafile.avsb.cloud/v2/{key}`, `sdk.avsb.cloud/v1/datafile/{key}`)
 * and 404s.
 */
export function datafileUrl(sdkKey: string, cdnHost: string = DEFAULT_CDN_HOST): string {
  const key = requireSdkKey(sdkKey, 'datafileUrl')
  return `${trimTrailingSlashes(cdnHost)}/${key}/${DATAFILE_FILENAME}`
}

/**
 * Per-environment preview snapshot: `{cdnHost}/{sdkKey}/preview.json`.
 * Served with `no-store`, so a reader always gets the latest publish.
 */
export function previewUrl(sdkKey: string, cdnHost: string = DEFAULT_CDN_HOST): string {
  const key = requireSdkKey(sdkKey, 'previewUrl')
  return `${trimTrailingSlashes(cdnHost)}/${key}/${PREVIEW_FILENAME}`
}

/** R2/CDN object key for the live datafile. Used by the publisher. */
export function datafileObjectKey(sdkKey: string): string {
  return `${requireSdkKey(sdkKey, 'datafileObjectKey')}/${DATAFILE_FILENAME}`
}

/** R2/CDN object key for the preview snapshot. Used by the publisher. */
export function previewObjectKey(sdkKey: string): string {
  return `${requireSdkKey(sdkKey, 'previewObjectKey')}/${PREVIEW_FILENAME}`
}

// ---------------------------------------------------------------------
// Event ingestion.
// ---------------------------------------------------------------------

/**
 * Normalise whatever the datafile carries in `collectEndpoint` down to a
 * bare origin.
 *
 * The flag datafile publishes an origin (`https://ingest.avsb.cloud`);
 * the web-experiment datafile publishes the full batch URL
 * (`https://ingest.avsb.cloud/v1/collect/batch`) because the snippet
 * only ever posts batches. Both are valid inputs here, so an SDK never
 * has to care which datafile family it was handed and can never produce
 * `/v1/collect/batch/v1/collect/batch`.
 */
export function collectOriginFrom(collectEndpoint: string): string {
  const trimmed = trimTrailingSlashes(collectEndpoint.trim())
  for (const path of Object.values(COLLECT_PATHS)) {
    if (trimmed.endsWith(path)) {
      return trimmed.slice(0, trimmed.length - path.length)
    }
  }
  return trimmed
}

/**
 * Build an ingestion URL.
 *
 * `collectEndpoint` is the datafile's `collectEndpoint` value (origin or
 * full collect URL, see `collectOriginFrom`). It defaults to the public
 * ingest host so an SDK evaluated against a bootstrap datafile that
 * predates the field still reaches ingestion.
 */
export function collectUrl(
  kind: CollectPathKey,
  collectEndpoint: string = DEFAULT_COLLECT_HOST,
): string {
  return `${collectOriginFrom(collectEndpoint)}${COLLECT_PATHS[kind]}`
}

// ---------------------------------------------------------------------
// Streaming (SSE datafile push).
//
// Two hops:
//   1. GET  {streamEndpoint}?sdkKey=...        → {url, token, expiresInMs}
//   2. GET  {url}?sdkKey=...&token=...         → text/event-stream
//
// The endpoint itself is SERVER CONTROLLED: the publisher writes
// `streamEndpoint` into the datafile. An SDK that finds neither an
// explicit option nor a datafile field must leave streaming OFF and say
// so. It must never guess a host: a default of `stream.avsb.cloud` gave
// every Go customer an infinite reconnect loop against DNS that does
// not resolve.
// ---------------------------------------------------------------------

export type StreamEndpointResolution =
  | { available: true; endpoint: string; source: 'option' | 'datafile' }
  | { available: false; reason: string }

export interface StreamEndpointInput {
  /** Explicit constructor option. Wins over everything. */
  optionEndpoint?: string | null
  /** `streamEndpoint` as published in the datafile. */
  datafileStreamEndpoint?: string | null
}

/**
 * Resolve the stream ticket endpoint. Precedence: explicit option, then
 * the datafile field, then nothing.
 *
 * The `reason` on an unavailable result is written to be pasted into a
 * support thread as-is: it says what is missing and where to fix it.
 */
export function resolveStreamEndpoint(
  input: StreamEndpointInput,
): StreamEndpointResolution {
  const option = input.optionEndpoint?.trim()
  if (option) {
    return { available: true, endpoint: trimTrailingSlashes(option), source: 'option' }
  }

  const fromDatafile = input.datafileStreamEndpoint?.trim()
  if (fromDatafile) {
    return {
      available: true,
      endpoint: trimTrailingSlashes(fromDatafile),
      source: 'datafile',
    }
  }

  return {
    available: false,
    reason:
      'Streaming is on, but there is no stream endpoint to connect to: the ' +
      'datafile carries no "streamEndpoint" field and no streamingEndpoint ' +
      'option was passed. Republish the environment from the A vs B dashboard ' +
      '(Environments in the project sidebar) to pick up the field, or pass ' +
      'streamingEndpoint explicitly. Polling stays on in the meantime, so flag ' +
      'changes still arrive, just on the polling interval instead of instantly.',
  }
}

/** Step 1: the ticket request URL. */
export function streamTicketUrl(streamEndpoint: string, sdkKey: string): string {
  const key = requireSdkKey(sdkKey, 'streamTicketUrl')
  return `${trimTrailingSlashes(streamEndpoint)}?sdkKey=${encodeURIComponent(key)}`
}

/**
 * Step 2: the SSE URL.
 *
 * `subscribeBaseUrl` is the `url` field the TICKET RESPONSE handed back, not
 * the ticket endpoint itself. The token rides in the query string because
 * `EventSource` cannot set request headers. Tokens are single-resource and
 * expire in 60 seconds.
 */
export function streamSubscribeUrl(
  subscribeBaseUrl: string,
  sdkKey: string,
  token: string,
): string {
  const key = requireSdkKey(sdkKey, 'streamSubscribeUrl')
  return (
    `${trimTrailingSlashes(subscribeBaseUrl)}?sdkKey=${encodeURIComponent(key)}` +
    `&token=${encodeURIComponent(token)}`
  )
}

/** Fallback stream ticket URL, for docs, tests, and the publisher. */
export function streamEndpointUrl(appHost: string = DEFAULT_APP_HOST): string {
  return `${trimTrailingSlashes(appHost)}${STREAM_TICKET_PATH}`
}

// ---------------------------------------------------------------------
// Heartbeat (SDK liveness, drives Connected / Stale / Not connected).
// ---------------------------------------------------------------------

/** Fallback heartbeat URL, for docs, tests, and the publisher. */
export function heartbeatUrl(appHost: string = DEFAULT_APP_HOST): string {
  return `${trimTrailingSlashes(appHost)}${HEARTBEAT_PATH}`
}

/**
 * Resolve the heartbeat endpoint from the datafile.
 *
 * `null` means "do not send heartbeats". The endpoint is deliberately
 * NOT defaulted to `app.avsb.cloud`: a self-hosted or proxied
 * deployment publishes its own origin, and heartbeats posted to the
 * wrong host would report liveness nowhere while looking healthy.
 */
export function resolveHeartbeatEndpoint(
  datafileHeartbeatEndpoint?: string | null,
): string | null {
  const value = datafileHeartbeatEndpoint?.trim()
  return value ? value : null
}
