import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isMultiContext } from '@avsbhq/core'
import {
  ANON_STORAGE_KEY,
  SNIPPET_COOKIE_NAME,
  anonymousContext,
  buildContextFromOptions,
  generateAnonId,
  persistVisitorId,
  primaryKeyOf,
  readSnippetVisitorId,
  resolveVisitorId,
  rotateVisitorId,
} from './identity'

function clearCookies(): void {
  for (const part of document.cookie.split('; ')) {
    const name = part.split('=')[0]
    if (name) document.cookie = `${name}=; path=/; max-age=0`
  }
}

function setSnippetCookie(value: unknown): void {
  document.cookie = `${SNIPPET_COOKIE_NAME}=${encodeURIComponent(
    JSON.stringify(value),
  )}; path=/`
}

/** Replace localStorage with a double that rejects every write. */
function breakLocalStorage(): void {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
    removeItem: () => undefined,
  })
}

/**
 * Shadow `document.cookie` with a throwing accessor. Defining an own
 * property on the instance hides the prototype accessor; deleting it puts
 * the real one back.
 */
function breakCookies(): () => void {
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get: () => '',
    set: () => {
      throw new Error('cookies are blocked')
    },
  })
  return () => {
    delete (document as unknown as Record<string, unknown>)['cookie']
  }
}

beforeEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  clearCookies()
})

describe('resolveVisitorId', () => {
  it('persists a generated id so the next page load buckets the same visitor', () => {
    const first = resolveVisitorId()
    expect(first.source).toBe('generated')
    expect(first.id.startsWith('anon_')).toBe(true)

    // A second client on the next page load must read the same id back. The
    // old per-load `anon_${Date.now()}_${n}` key re-bucketed every anonymous
    // visitor on every navigation.
    const second = resolveVisitorId()
    expect(second.id).toBe(first.id)
    expect(second.source).toBe('storage')
  })

  it('adopts the snippet visitor id when Web Experiments is on the same page', () => {
    setSnippetCookie({ v: 'snippet-visitor-42', a: { exp1: 'var1' } })

    const resolved = resolveVisitorId()

    expect(resolved.id).toBe('snippet-visitor-42')
    expect(resolved.source).toBe('snippet')
    // Adoption is read-only: the snippet cookie also carries the experiment
    // assignment map, and a partial write from here would drop it.
    expect(document.cookie).toContain('exp1')
  })

  it('ignores the snippet cookie when adoption is switched off', () => {
    setSnippetCookie({ v: 'snippet-visitor-42', a: {} })

    const resolved = resolveVisitorId({ adoptSnippetVisitorId: false })

    expect(resolved.id).not.toBe('snippet-visitor-42')
    expect(resolved.source).toBe('generated')
  })

  it('ignores a malformed snippet cookie instead of throwing', () => {
    document.cookie = `${SNIPPET_COOKIE_NAME}=not-json; path=/`

    expect(readSnippetVisitorId()).toBeNull()
    expect(resolveVisitorId().source).toBe('generated')
  })

  it('falls back to a cookie when localStorage refuses to store', () => {
    // Safari private mode and blocked third-party storage both throw here
    // rather than returning null, which is why every access is wrapped.
    breakLocalStorage()

    const resolved = resolveVisitorId()

    expect(resolved.source).toBe('generated')
    expect(document.cookie).toContain(ANON_STORAGE_KEY)

    // The cookie is what the next load reads back.
    const next = resolveVisitorId()
    expect(next.id).toBe(resolved.id)
    expect(next.source).toBe('cookie')
  })

  it('warns with an actionable message when nothing can persist', () => {
    breakLocalStorage()
    const restoreCookies = breakCookies()
    const warn = vi.fn()

    try {
      persistVisitorId('anon_x', {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
        child: () => {
          throw new Error('child logger is not used here')
        },
      })
    } finally {
      restoreCookies()
    }

    expect(warn).toHaveBeenCalledTimes(1)
    const message = warn.mock.calls[0][0] as string
    expect(message).toContain('re-bucketed')
    expect(message).toContain('context')
  })
})

describe('rotateVisitorId', () => {
  it('mints and persists a different id, so a logout is a new visitor', () => {
    const before = resolveVisitorId().id
    const after = rotateVisitorId()

    expect(after).not.toBe(before)
    expect(resolveVisitorId().id).toBe(after)
  })
})

describe('generateAnonId', () => {
  it('produces distinct ids even for calls in the same millisecond', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateAnonId()))
    expect(ids.size).toBe(100)
  })
})

describe('buildContextFromOptions', () => {
  it('uses an explicit context untouched', () => {
    const explicit = { kind: 'user' as const, key: 'u_1', plan: 'pro' }
    expect(
      buildContextFromOptions({ context: explicit, anonymousId: 'anon_x' }),
    ).toBe(explicit)
  })

  it('keeps every attribute on an explicit context, including the bucketing key', () => {
    const ctx = buildContextFromOptions({
      context: { kind: 'user', key: 'u_7', plan: 'pro' },
      anonymousId: 'anon_x',
    })

    // Narrowed rather than converted: the return is EvalContext, and the multi
    // arm shares no attribute shape with the single one. That it stayed single
    // is part of what this test is checking.
    if (isMultiContext(ctx)) throw new Error('expected the explicit single context back')
    expect(ctx.key).toBe('u_7')
    expect(ctx.plan).toBe('pro')
    // An identified context is not anonymous.
    expect(ctx._meta).toBeUndefined()
  })

  it('falls back to the persisted anonymous id and marks the context anonymous', () => {
    const ctx = buildContextFromOptions({
      anonymousId: 'anon_persisted',
    }) as { key: string; _meta?: { anonymous?: boolean } }

    expect(ctx.key).toBe('anon_persisted')
    expect(ctx._meta?.anonymous).toBe(true)
  })

  it('marks a multi-context as given, without synthesising identity into it', () => {
    const multi = {
      kind: 'multi' as const,
      user: { kind: 'user', key: 'u_1' },
      organization: { kind: 'organization', key: 'org_1' },
    }
    expect(buildContextFromOptions({ context: multi, anonymousId: 'anon_x' })).toBe(
      multi,
    )
  })
})

describe('primaryKeyOf', () => {
  it('reads the key of a single context', () => {
    expect(primaryKeyOf({ kind: 'user', key: 'u_1' })).toBe('u_1')
  })

  it('reads the user sub-context under multi-context', () => {
    expect(
      primaryKeyOf({
        kind: 'multi',
        user: { kind: 'user', key: 'u_1' },
        organization: { kind: 'organization', key: 'org_1' },
      }),
    ).toBe('u_1')
  })

  it('returns an empty key for a multi-context with no user kind', () => {
    expect(
      primaryKeyOf({
        kind: 'multi',
        organization: { kind: 'organization', key: 'org_1' },
      }),
    ).toBe('')
  })
})

describe('anonymousContext', () => {
  it('builds a user context flagged anonymous', () => {
    const ctx = anonymousContext('anon_1')
    expect(ctx.kind).toBe('user')
    expect(ctx.key).toBe('anon_1')
    expect(ctx._meta?.anonymous).toBe(true)
  })
})
