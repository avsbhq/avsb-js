/**
 * Who a decision is for.
 *
 * The Flags SDK's own answer is `identify`, declared next to the flag:
 *
 *   export const newCheckout = flag<boolean, EvalContext>({
 *     key: 'new-checkout-flow',
 *     adapter: avsbAdapter.booleanValue(),
 *     defaultValue: false,
 *     identify: ({ cookies }) => ({
 *       kind: 'user',
 *       key: cookies.get('uid')?.value ?? 'anonymous',
 *     }),
 *   })
 *
 * When a flag has no `identify`, this falls back to a visitor cookie, if one of
 * the two A vs B products already set one on this domain. With neither, there
 * is nothing to evaluate against: the flag returns its default and says so
 * once, rather than inventing an id and quietly splitting one visitor across
 * every request.
 */
import type { Logger } from '@avsbhq/core';
import type { CookiesLike, EvalContext } from './types';

/**
 * The anonymous visitor cookie.
 *
 * The browser SDK persists this id in localStorage first and only writes a
 * cookie of the same name when localStorage is unavailable, so on a plain
 * client-rendered app this cookie is often absent. The dependable server-side
 * setter is the `withAvsb` middleware in `@avsbhq/next`, which maintains it on
 * every request. Set it there (or pass `identify`) if you want server and
 * browser to bucket the same anonymous visitor.
 */
export const DEFAULT_ANON_COOKIE = 'avsb_anon_id';

/**
 * The web experiments snippet's visitor cookie. Its body is percent-encoded
 * JSON (`{"v":"<id>","a":{…}}`, snippet/src/cookie.ts), never a bare id.
 */
export const SNIPPET_VISITOR_COOKIE = '_avsb_visitor';

export interface ResolveEvalContextInput {
  flagKey: string;
  entities?: unknown;
  cookies?: CookiesLike;
  /** Checked before the snippet cookie. Default `avsb_anon_id`. */
  anonCookieName?: string;
  /** Called once per flag key when nothing identifies the visitor. */
  logger?: Logger;
  /** Flag keys already warned about, so a busy route logs once, not per request. */
  warned?: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this a usable `EvalContext`?
 *
 * A single context needs a non-empty `key` (the bucketing identifier). A multi
 * context needs at least one member, and each member is itself checked, so a
 * half-built object cannot reach the evaluator and bucket everyone into the
 * same variation.
 */
export function isEvalContext(value: unknown): value is EvalContext {
  if (!isRecord(value)) return false;
  if (typeof value['kind'] !== 'string' || value['kind'].length === 0) {
    return false;
  }

  if (value['kind'] !== 'multi') {
    return typeof value['key'] === 'string' && value['key'].length > 0;
  }

  const members = Object.entries(value).filter(([name]) => name !== 'kind');
  return (
    members.length > 0 &&
    members.every(
      ([, member]) =>
        isRecord(member) && typeof member['key'] === 'string' && member['key'].length > 0,
    )
  );
}

function readCookie(cookies: CookiesLike | undefined, name: string): string | null {
  const value = cookies?.get(name)?.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The visitor id inside the snippet's cookie.
 *
 * The cookie body is percent-encoded JSON (`{"v":"<id>","a":{…}}`), so the raw
 * value is a blob, not an id: using it as a bucketing key would give every
 * visitor a different key on every attribute change and match nothing the
 * browser buckets. Mirrors `readSnippetVisitorId` in
 * `packages/avsb-edge/src/requestContext.ts` and the browser SDK's adoption
 * path in `packages/avsb-browser/src/identity.ts`.
 *
 * A cookie that cannot be parsed is treated as absent rather than as an error:
 * another product may own a cookie of that name on this domain.
 */
export function readSnippetVisitorId(rawCookieValue: string | null): string | null {
  if (!rawCookieValue) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(rawCookieValue));
    if (isRecord(parsed) && typeof parsed['v'] === 'string' && parsed['v'].length > 0) {
      return parsed['v'];
    }
  } catch {
    // Unparseable means "not ours". Fall through to no visitor.
  }
  return null;
}

function warnOnce(input: ResolveEvalContextInput): void {
  const warned = input.warned;
  if (warned) {
    if (warned.has(input.flagKey)) return;
    warned.add(input.flagKey);
  }

  input.logger?.warn(
    `[avsb] "${input.flagKey}" was evaluated with nothing to identify the ` +
      'visitor, so it returned its default value and recorded no exposure. Add an ' +
      'identify() to the flag declaration (identify: ({ cookies }) => ({ kind: ' +
      "'user', key: … })), or set the " +
      `${input.anonCookieName ?? DEFAULT_ANON_COOKIE} cookie for anonymous ` +
      'visitors with the withAvsb middleware from @avsbhq/next.',
  );
}

/**
 * The context one decision is made for, or null when nobody can be identified.
 */
export function resolveEvalContext(input: ResolveEvalContextInput): EvalContext | null {
  if (isEvalContext(input.entities)) return input.entities;

  const anonCookieName = input.anonCookieName ?? DEFAULT_ANON_COOKIE;
  const anonId =
    readCookie(input.cookies, anonCookieName) ??
    readSnippetVisitorId(readCookie(input.cookies, SNIPPET_VISITOR_COOKIE));

  if (anonId !== null) return { kind: 'user', key: anonId };

  warnOnce(input);
  return null;
}
