import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { Logger } from '@avsbhq/core';
import {
  DEFAULT_ANON_COOKIE,
  SNIPPET_VISITOR_COOKIE,
  isEvalContext,
  readSnippetVisitorId,
  resolveEvalContext,
} from './context';
import type { CookiesLike } from './types';

function cookies(jar: Record<string, string>): CookiesLike {
  return {
    get: (name) => {
      const value = jar[name];
      return value === undefined ? undefined : { value };
    },
  };
}

/** Exactly what snippet/src/cookie.ts writes: percent-encoded JSON. */
function snippetCookie(visitorId: string, attributes: Record<string, unknown> = {}): string {
  return encodeURIComponent(JSON.stringify({ v: visitorId, a: attributes }));
}

function testLogger() {
  // The mocks carry the method's own signature. A bare `vi.fn()` is typed
  // `Mock<Procedure | Constructable>`, which satisfies neither half of the
  // intersection, so the calls could not be inspected as a logger's.
  const logger: Logger & {
    warn: Mock<Logger['warn']>;
    error: Mock<Logger['error']>;
  } = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
    child: () => logger,
  };
  return logger;
}

describe('isEvalContext', () => {
  it('accepts a single context with a key', () => {
    expect(isEvalContext({ kind: 'user', key: 'u_1' })).toBe(true);
    expect(isEvalContext({ kind: 'organization', key: 'org_1', tier: 'pro' })).toBe(true);
  });

  it('accepts a multi context whose members all have keys', () => {
    expect(
      isEvalContext({
        kind: 'multi',
        user: { kind: 'user', key: 'u_1' },
        organization: { kind: 'organization', key: 'org_1' },
      }),
    ).toBe(true);
  });

  it('rejects the shapes that would bucket everyone the same way', () => {
    expect(isEvalContext(undefined)).toBe(false);
    expect(isEvalContext(null)).toBe(false);
    expect(isEvalContext('u_1')).toBe(false);
    expect(isEvalContext([{ kind: 'user', key: 'u_1' }])).toBe(false);
    expect(isEvalContext({ key: 'u_1' })).toBe(false);
    expect(isEvalContext({ kind: 'user' })).toBe(false);
    expect(isEvalContext({ kind: 'user', key: '' })).toBe(false);
    expect(isEvalContext({ kind: 'user', key: 42 })).toBe(false);
    // A multi context with no members, and one whose member has no key.
    expect(isEvalContext({ kind: 'multi' })).toBe(false);
    expect(isEvalContext({ kind: 'multi', user: { kind: 'user', key: '' } })).toBe(false);
  });
});

describe('readSnippetVisitorId', () => {
  it('takes the id out of the percent-encoded JSON the snippet writes', () => {
    expect(readSnippetVisitorId(snippetCookie('v_1', { plan: 'pro' }))).toBe('v_1');
  });

  it('reads a cookie value that arrived already decoded', () => {
    // Some cookie stores decode for you; JSON.parse still has to see the object.
    expect(readSnippetVisitorId('{"v":"v_1","a":{}}')).toBe('v_1');
  });

  it('is null for anything that is not a snippet cookie', () => {
    expect(readSnippetVisitorId(null)).toBeNull();
    expect(readSnippetVisitorId('')).toBeNull();
    // The raw-value bug this guards: a bare id is NOT what the snippet writes.
    expect(readSnippetVisitorId('v_snippet')).toBeNull();
    expect(readSnippetVisitorId('%7Bnot-json')).toBeNull();
    expect(readSnippetVisitorId(encodeURIComponent('{"a":{}}'))).toBeNull();
    expect(readSnippetVisitorId(encodeURIComponent('{"v":""}'))).toBeNull();
    expect(readSnippetVisitorId(encodeURIComponent('{"v":42}'))).toBeNull();
    expect(readSnippetVisitorId(encodeURIComponent('["v_1"]'))).toBeNull();
  });
});

describe('resolveEvalContext', () => {
  it('uses what identify() returned', () => {
    expect(
      resolveEvalContext({
        flagKey: 'new-checkout-flow',
        entities: { kind: 'user', key: 'u_1', plan: 'pro' },
        cookies: cookies({ [DEFAULT_ANON_COOKIE]: 'anon_9' }),
      }),
    ).toEqual({ kind: 'user', key: 'u_1', plan: 'pro' });
  });

  it('falls back to the anonymous visitor cookie when a flag has no identify', () => {
    expect(
      resolveEvalContext({
        flagKey: 'new-checkout-flow',
        cookies: cookies({ [DEFAULT_ANON_COOKIE]: 'anon_9' }),
      }),
    ).toEqual({ kind: 'user', key: 'anon_9' });
  });

  it('unwraps the snippet cookie, so both products bucket one visitor', () => {
    expect(
      resolveEvalContext({
        flagKey: 'new-checkout-flow',
        cookies: cookies({
          [SNIPPET_VISITOR_COOKIE]: snippetCookie('v_snippet', { plan: 'pro' }),
        }),
      }),
    ).toEqual({ kind: 'user', key: 'v_snippet' });
  });

  it('treats an unreadable snippet cookie as no visitor at all', () => {
    for (const raw of ['v_snippet', '%7Bnot-json', encodeURIComponent('{"a":{}}')]) {
      expect(
        resolveEvalContext({
          flagKey: 'new-checkout-flow',
          cookies: cookies({ [SNIPPET_VISITOR_COOKIE]: raw }),
        }),
      ).toBeNull();
    }
  });

  it('prefers the SDK cookie over the snippet cookie', () => {
    expect(
      resolveEvalContext({
        flagKey: 'new-checkout-flow',
        cookies: cookies({
          [DEFAULT_ANON_COOKIE]: 'anon_9',
          [SNIPPET_VISITOR_COOKIE]: snippetCookie('v_snippet'),
        }),
      }),
    ).toEqual({ kind: 'user', key: 'anon_9' });
  });

  it('honours a custom cookie name', () => {
    expect(
      resolveEvalContext({
        flagKey: 'new-checkout-flow',
        cookies: cookies({ visitor_id: 'v_1' }),
        anonCookieName: 'visitor_id',
      }),
    ).toEqual({ kind: 'user', key: 'v_1' });
  });

  it('ignores entities that are not a usable context and falls through to the cookie', () => {
    expect(
      resolveEvalContext({
        flagKey: 'new-checkout-flow',
        entities: { kind: 'user', key: '' },
        cookies: cookies({ [DEFAULT_ANON_COOKIE]: 'anon_9' }),
      }),
    ).toEqual({ kind: 'user', key: 'anon_9' });
  });

  it('returns null rather than inventing an id when nobody can be identified', () => {
    expect(
      resolveEvalContext({
        flagKey: 'new-checkout-flow',
        cookies: cookies({}),
      }),
    ).toBeNull();
  });

  it('warns once per flag key, naming identify() and the cookie', () => {
    const logger = testLogger();
    const warned = new Set<string>();
    const input = { cookies: cookies({}), logger, warned };

    resolveEvalContext({ flagKey: 'new-checkout-flow', ...input });
    resolveEvalContext({ flagKey: 'new-checkout-flow', ...input });
    resolveEvalContext({ flagKey: 'pricing-test', ...input });

    expect(logger.warn).toHaveBeenCalledTimes(2);
    const message = String(logger.warn.mock.calls[0]?.[0]);
    expect(message).toContain('new-checkout-flow');
    expect(message).toContain('identify()');
    expect(message).toContain(DEFAULT_ANON_COOKIE);
  });
});
