// =====================================================================
// Persistent browser identity (WS2 item 3, report 02 §5.5 and §6,
// report 03 handoff item 7).
//
// The bug this replaces: anonymous keys were `anon_${Date.now()}_${n}`,
// held in memory only. Every page load produced a NEW key, so every
// anonymous visitor was re-bucketed on every navigation: new variation,
// new visitorId on events, and experiment results that cannot be trusted.
// Sticky bucketing could not compensate, because the thing that changed
// was the bucketing key itself.
//
// The identity resolved here, in priority order:
//
//   1. The snippet's `_avsb_visitor` cookie, when Web Experiments is also
//      installed on this page. Adopting it is what makes a feature-flag
//      exposure and a web-experiment exposure join to ONE visitor in
//      results. Read only: the SDK never writes that cookie, because it
//      also carries the snippet's experiment assignment map (`a`) and a
//      partial write from here would drop assignments.
//   2. Our own persisted id in localStorage, then in a first-party cookie
//      when localStorage is unavailable (Safari private mode, storage
//      disabled, sandboxed iframe: reading it can THROW, not just return
//      null, so every access here is wrapped).
//   3. A freshly generated `anon_<uuid>`, persisted for next time.
//
// A caller who passes an explicit `context` (or `attributes.userId`) is
// always authoritative; this only supplies the anonymous case.
// =====================================================================

import { isMultiContext, getContextByKind } from '@avsbhq/core'
import type { EvalContext, SingleContext, Logger } from '@avsbhq/core'

/** Our own persisted anonymous id. Shared across environments on a domain. */
export const ANON_STORAGE_KEY = 'avsb_anon_id'

/** The snippet's visitor cookie (snippet/src/cookie.ts). Read only. */
export const SNIPPET_COOKIE_NAME = '_avsb_visitor'

const COOKIE_MAX_AGE_SECONDS = 31_536_000 // 1 year, matching the snippet

export type VisitorIdSource = 'snippet' | 'storage' | 'cookie' | 'generated'

export interface ResolvedVisitorId {
  id: string
  source: VisitorIdSource
}

// ---------------------------------------------------------------------
// Storage primitives. Every one of these is failure-tolerant: identity
// must degrade to in-memory, never throw into the constructor.
// ---------------------------------------------------------------------

function readLocalStorage(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocalStorage(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function readCookie(name: string): string | null {
  try {
    if (typeof document === 'undefined' || typeof document.cookie !== 'string') {
      return null
    }
    for (const part of document.cookie.split('; ')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      if (part.slice(0, eq) === name) return part.slice(eq + 1)
    }
    return null
  } catch {
    return null
  }
}

function writeCookie(name: string, value: string): boolean {
  try {
    if (typeof document === 'undefined') return false
    document.cookie = `${name}=${value}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------
// Id generation
// ---------------------------------------------------------------------

/**
 * A fresh anonymous id. Keeps the `anon_` prefix so an id read in results
 * or in a support thread is immediately recognisable as unidentified
 * traffic, and uses a UUID body so two tabs opening in the same
 * millisecond cannot collide (the old timestamp-plus-counter form could,
 * because the counter was per module instance).
 */
export function generateAnonId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `anon_${crypto.randomUUID()}`
  }
  // Fallback for environments without Web Crypto.
  const random = Math.random().toString(36).slice(2, 12)
  return `anon_${Date.now().toString(36)}${random}`
}

/**
 * Read the id out of the snippet's visitor cookie, or null when Web
 * Experiments is not installed here. The cookie body is a URL-encoded
 * JSON object `{ v: <uuid>, a: { ... } }`; anything else is ignored.
 */
export function readSnippetVisitorId(): string | null {
  const raw = readCookie(SNIPPET_COOKIE_NAME)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { v?: unknown }).v === 'string' &&
      (parsed as { v: string }).v.length > 0
    ) {
      return (parsed as { v: string }).v
    }
    return null
  } catch {
    return null
  }
}

export interface VisitorIdOptions {
  /** Adopt the snippet's `_avsb_visitor` id when present. Default true. */
  adoptSnippetVisitorId?: boolean
  /** Persist our own id. Default true. */
  persist?: boolean
  logger?: Logger
}

/**
 * Resolve the anonymous visitor id for this browser, persisting a newly
 * generated one so the next page load buckets identically.
 */
export function resolveVisitorId(
  options: VisitorIdOptions = {},
): ResolvedVisitorId {
  const adopt = options.adoptSnippetVisitorId !== false
  const persist = options.persist !== false

  if (adopt) {
    const snippetId = readSnippetVisitorId()
    if (snippetId) {
      options.logger?.debug('adopted the snippet visitor id', {
        source: SNIPPET_COOKIE_NAME,
      })
      return { id: snippetId, source: 'snippet' }
    }
  }

  const stored = readLocalStorage(ANON_STORAGE_KEY)
  if (stored) return { id: stored, source: 'storage' }

  const fromCookie = readCookie(ANON_STORAGE_KEY)
  if (fromCookie) return { id: fromCookie, source: 'cookie' }

  const fresh = generateAnonId()
  if (persist) persistVisitorId(fresh, options.logger)
  return { id: fresh, source: 'generated' }
}

/**
 * Persist an anonymous id. localStorage first, cookie as the fallback so
 * a browser with storage blocked still buckets consistently for the
 * session and across same-domain navigations.
 */
export function persistVisitorId(id: string, logger?: Logger): void {
  if (writeLocalStorage(ANON_STORAGE_KEY, id)) return
  if (writeCookie(ANON_STORAGE_KEY, id)) {
    logger?.debug('persisted the visitor id in a cookie', {
      reason: 'localStorage unavailable',
    })
    return
  }
  logger?.warn(
    'AvsB could not persist the anonymous visitor id: both localStorage and cookies ' +
      'are unavailable in this browser context, so this visitor will be re-bucketed ' +
      'on the next page load. Pass an explicit context with your own stable key to ' +
      'keep bucketing consistent.',
  )
}

/**
 * Forget the current anonymous id and mint a new one. This is the
 * identity half of `client.reset()`: after a logout the next anonymous
 * session must be a genuinely new visitor, not the previous user's id.
 */
export function rotateVisitorId(logger?: Logger): string {
  const fresh = generateAnonId()
  persistVisitorId(fresh, logger)
  return fresh
}

// ---------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------

export interface BuildContextInput {
  context?: EvalContext
  /** The resolved anonymous id, used when `context` identifies nobody. */
  anonymousId: string
}

/**
 * Build the bound context from constructor options.
 *
 * There is ONE identity model now: `context`. The parallel
 * `attributes` + `userIdAttribute` pair was deleted (breaking change B5); two
 * identity models meant every adapter, doc page, and port had to explain both,
 * and the second one could not express multi-context at all. Pass
 * `context: { kind: 'user', key: userId, ...attributes }`.
 */
export function buildContextFromOptions(input: BuildContextInput): EvalContext {
  if (input.context) return input.context
  return {
    kind: 'user',
    key: input.anonymousId,
    _meta: { anonymous: true },
  } as SingleContext
}

/** The bucketing key of a context: the user sub-context under multi. */
export function primaryKeyOf(ctx: EvalContext): string {
  if (isMultiContext(ctx)) {
    const user = getContextByKind(ctx, 'user')
    return user ? user.key : ''
  }
  return (ctx as SingleContext).key
}

/** The anonymous context `reset()` installs. */
export function anonymousContext(anonymousId: string): SingleContext {
  return { kind: 'user', key: anonymousId, _meta: { anonymous: true } }
}
