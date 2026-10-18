// =====================================================================
// The persistent anonymous visitor id (report 03 §6, §7 item 12).
//
// THE PROBLEM THIS SOLVES: the server and the browser each invented their
// own anonymous identity, so a visitor could be bucketed into variation A
// by the server render and variation B by the client a moment later.
// Every anonymous experiment on a Next.js app was measuring noise.
//
// One id, one cookie, both sides. `withAvsb` middleware mints it and
// writes it; `<AvsbRoot>` reads it for the server evaluation and hands the
// same key to the browser client, so both bucket identically, and the
// cookie keeps it stable across visits.
// =====================================================================

/** Cookie name. Deliberately distinct from the web snippet's `_avsb_visitor`. */
export const AVSB_ANON_COOKIE = 'avsb_anon_id'

/** One year. Long enough that a returning visitor keeps their variation. */
export const AVSB_ANON_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

const ID_PREFIX = 'anon_'

export interface AnonCookieOptions {
  /** Cookie name. Default `avsb_anon_id`. */
  name?: string
  /** Lifetime in seconds. Default one year. */
  maxAgeSeconds?: number
  /** Cookie path. Default '/'. */
  path?: string
  /** SameSite policy. Default 'lax'. */
  sameSite?: 'lax' | 'strict' | 'none'
  /** Secure flag. Default true, so it is not sent over plain HTTP. */
  secure?: boolean
  /** Domain, for sharing the id across subdomains. */
  domain?: string
}

/** The resolved attributes, with every default filled in. */
export interface ResolvedAnonCookie {
  name: string
  maxAge: number
  path: string
  sameSite: 'lax' | 'strict' | 'none'
  secure: boolean
  domain?: string
  /** Not httpOnly: the browser SDK reads this id too. */
  httpOnly: false
}

export function resolveAnonCookieOptions(
  options?: AnonCookieOptions,
): ResolvedAnonCookie {
  return {
    name: options?.name ?? AVSB_ANON_COOKIE,
    maxAge: options?.maxAgeSeconds ?? AVSB_ANON_MAX_AGE_SECONDS,
    path: options?.path ?? '/',
    sameSite: options?.sameSite ?? 'lax',
    secure: options?.secure ?? true,
    ...(options?.domain ? { domain: options.domain } : {}),
    httpOnly: false,
  }
}

/**
 * Mint a new anonymous id.
 *
 * `crypto.randomUUID` where it exists (every Next runtime: node 19+, edge,
 * and the browser), with a random fallback so this never throws in an
 * exotic runtime.
 */
export function createAnonId(): string {
  const webCrypto: Crypto | undefined = globalThis.crypto
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return `${ID_PREFIX}${webCrypto.randomUUID()}`
  }
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    const bytes = webCrypto.getRandomValues(new Uint8Array(16))
    let hex = ''
    for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
    return `${ID_PREFIX}${hex}`
  }
  return `${ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

/**
 * Is this cookie value one of ours?
 *
 * Anything else (a truncated copy, another product's cookie under the same
 * name, an empty string) is treated as absent and replaced, rather than
 * used as a bucketing key.
 */
export function isAnonId(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.startsWith(ID_PREFIX) && value.length > ID_PREFIX.length + 8
}

/**
 * The id to use for this request: the one in the cookie when it is valid,
 * a fresh one otherwise.
 */
export function resolveAnonId(existing: string | undefined | null): {
  id: string
  isNew: boolean
} {
  if (isAnonId(existing)) return { id: existing, isNew: false }
  return { id: createAnonId(), isNew: true }
}
