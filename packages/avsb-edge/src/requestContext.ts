// =====================================================================
// Turning an incoming request into an EvalContext.
//
// THE BUG THIS EXISTS TO KILL: `contextFrom` was declared in the options
// of all seven adapters and never called by any of them (report 02 §5.12).
// The option the whole edge README centred identity on was dead code, and
// because `getFlag(key, default, ctx)` demanded a context anyway, nobody
// noticed.
//
// Two halves of the fix live here:
//
//   1. Every adapter now CALLS `contextFrom` and binds the result to the
//      client, so `client.getFlag('key', false)` needs no third argument.
//   2. `contextFrom` becomes OPTIONAL, because each adapter has a real
//      default built on what its platform actually provides. A worker with
//      no identity code still buckets by the visitor the request carries
//      and still targets on the platform's own geo.
//
// ATTRIBUTE VOCABULARY
//
// Attribute names are taken from the visitor-data factories in
// `@avsbhq/utils` (`Geolocation` -> country/region/city/latitude/longitude,
// `Browser` -> userAgent/language/timezone, `PageView` -> url/path/referrer)
// so an audience authored once targets the snippet and the edge alike.
//
// Everything lands FLAT on one `user` context rather than in separate
// `geo`/`page`/`browser` sub-contexts, because a dashboard CUSTOM_ATTRIBUTE
// condition with no `contextKind` resolves against the primary context's
// attribute bag (packages/avsb-core/src/audience.ts, `resolveAttribute`).
// Splitting geo into its own kind would make an audience on `country`
// silently never match. Callers who want a multi-context return one from
// `contextFrom`; nothing here prevents that.
//
// An attribute we do not know is OMITTED, never written as an empty string,
// so an `exists` operator can tell "no geo available on this platform" from
// "geo says empty".
//
// IP IS NOT USED AS THE BUCKETING KEY, on purpose. It is tempting (it is
// the one identifier every request carries) but the bucketing key becomes
// `visitorId` on every exposure row, so bucketing on IP would write a
// personal identifier into analytics storage for every visitor. Coarse
// geo derived from the IP by the platform is fine and is used: it is not a
// stable per-person identifier. When no visitor id is present at all the
// client says so loudly (see `emptyContextMessage`) instead of inventing
// one.
// =====================================================================

import { getContextByKind, isMultiContext } from '@avsbhq/core'
import type { EvalContext, SingleContext } from '@avsbhq/core'

/** Explicit per-request identity header. Wins over the cookie. */
export const VISITOR_HEADER_NAME = 'x-avsb-visitor-id'

/** The A vs B snippet's visitor cookie (snippet/src/cookie.ts). Read only. */
export const VISITOR_COOKIE_NAME = '_avsb_visitor'

/** Context kind the defaults build. */
export const DEFAULT_CONTEXT_KIND = 'user'

/**
 * The visitor an event is attributed to, read from an evaluation context.
 *
 * A multi-context resolves through its `user` sub-context, which is the same
 * kind the evaluator buckets on, so an exposure and a conversion produced by
 * one request always carry the same id and join in results.
 */
export function visitorIdOf(ctx: EvalContext | undefined): string {
  if (!ctx) return ''
  if (isMultiContext(ctx)) return getContextByKind(ctx, 'user')?.key ?? ''
  return ctx.key
}

/**
 * The context an evaluation should run against.
 *
 * `onEmpty` is called when there is no identity anywhere: no context at all,
 * or a single context whose key is blank. An empty key buckets every visitor
 * identically, which quietly turns an A/B rule into a one-sided rollout, so
 * the caller warns rather than letting it pass. A multi-context is trusted
 * as-is, because the evaluator resolves the bucketing kind itself.
 */
export function contextForEvaluation(
  ctx: EvalContext | undefined,
  onEmpty: () => void,
): EvalContext {
  if (!ctx) {
    onEmpty()
    return { kind: DEFAULT_CONTEXT_KIND, key: '' }
  }
  if (!isMultiContext(ctx) && !ctx.key) onEmpty()
  return ctx
}

/**
 * Parse a `Cookie` request header into a name/value map.
 *
 * Values are returned still percent-encoded, exactly as they arrived,
 * because a caller reading their own cookie may or may not have encoded it.
 * `readSnippetVisitorId` does its own decode.
 */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    // First occurrence wins: a duplicated cookie name means one was set on
    // a narrower path or domain, and the browser sends the more specific
    // one first.
    if (out[name] === undefined) out[name] = part.slice(eq + 1).trim()
  }
  return out
}

/**
 * Extract the visitor id from the snippet's cookie value.
 *
 * The snippet stores percent-encoded JSON `{v: visitorId, a: {...}}`
 * (snippet/src/cookie.ts), so a naive read of the raw cookie value returns
 * a JSON blob rather than an id. Mirrors the browser SDK's adoption path
 * in packages/avsb-browser/src/identity.ts.
 */
export function readSnippetVisitorId(rawCookieValue: string | undefined): string | null {
  if (!rawCookieValue) return null
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(rawCookieValue))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { v?: unknown }).v === 'string' &&
      (parsed as { v: string }).v.length > 0
    ) {
      return (parsed as { v: string }).v
    }
  } catch {
    // A cookie we cannot parse is treated as absent. It is not an error:
    // another product may own a cookie of the same name on this domain.
  }
  return null
}

/** Header lookup that tolerates bare `{ get }` doubles. */
function header(headers: Pick<Headers, 'get'> | undefined, name: string): string | null {
  if (!headers || typeof headers.get !== 'function') return null
  return headers.get(name)
}

/**
 * Resolve the visitor id from a request: explicit header first, then the
 * snippet's cookie. Returns null when the request carries no identity.
 */
export function readVisitorId(headers: Pick<Headers, 'get'> | undefined): string | null {
  const explicit = header(headers, VISITOR_HEADER_NAME)
  if (explicit && explicit.trim()) return explicit.trim()

  const cookies = parseCookieHeader(header(headers, 'cookie'))
  return readSnippetVisitorId(cookies[VISITOR_COOKIE_NAME])
}

/**
 * Coarse location a platform reports for the request. Every field is
 * optional because no platform provides all of them and three of the seven
 * provide none.
 */
export interface EdgeGeo {
  country?: string
  region?: string
  city?: string
  continent?: string
  postalCode?: string
  timezone?: string
  latitude?: number
  longitude?: number
}

/** Numeric parse that refuses NaN and Infinity rather than passing them on. */
export function toFiniteNumber(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** Drop undefined and empty-string entries so absence stays absence. */
function defined(attributes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(attributes)) {
    if (v === undefined || v === null || v === '') continue
    out[k] = v
  }
  return out
}

/** Page attributes derived from the request URL. Never throws on a bad URL. */
export function pageAttributes(url: string | undefined): Record<string, unknown> {
  if (!url) return {}
  try {
    const parsed = new URL(url)
    return { url, path: parsed.pathname, host: parsed.host }
  } catch {
    // A relative or malformed URL still tells us something: keep it as-is.
    return { url }
  }
}

export interface BuildContextInput {
  /** Resolved visitor id, or null when the request carried none. */
  visitorId: string | null
  /** Request headers, read for userAgent / language / referer. */
  headers?: Pick<Headers, 'get'>
  /** Absolute request URL, when the runtime exposes one. */
  url?: string
  /** Platform-reported location, when the runtime exposes one. */
  geo?: EdgeGeo
  /** Extra platform attributes (colo, asn, request id). Merged last. */
  extra?: Record<string, unknown>
  /** Context kind. Defaults to 'user'. */
  kind?: string
}

/**
 * Assemble the `user` context the adapters bind by default.
 *
 * `key` is the empty string when no visitor id was found. That is not a
 * fallback identity, it is the signal the client warns on: an empty key
 * buckets every visitor identically, so the SDK says so once rather than
 * inventing a per-request id (which would bucket every request differently
 * and make an experiment produce noise instead of a result).
 */
export function buildRequestContext(input: BuildContextInput): SingleContext {
  const attributes = defined({
    ...pageAttributes(input.url),
    referrer: header(input.headers, 'referer') ?? undefined,
    userAgent: header(input.headers, 'user-agent') ?? undefined,
    language: header(input.headers, 'accept-language') ?? undefined,
    country: input.geo?.country,
    region: input.geo?.region,
    city: input.geo?.city,
    continent: input.geo?.continent,
    postalCode: input.geo?.postalCode,
    timezone: input.geo?.timezone,
    latitude: input.geo?.latitude,
    longitude: input.geo?.longitude,
    ...input.extra,
  })

  // Attributes spread FIRST so identity always wins. A platform that sent a
  // `key` or `kind` header, or an `extra` carrying either name, would
  // otherwise silently re-point bucketing at an attacker-supplied value.
  return {
    ...attributes,
    kind: input.kind ?? DEFAULT_CONTEXT_KIND,
    key: input.visitorId ?? '',
  }
}
