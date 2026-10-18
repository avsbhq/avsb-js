/**
 * The anonymous visitor id.
 *
 * It exists so the server render and the browser bucket the SAME person.
 * The rules that matter: a valid id is never replaced (a replaced id is a
 * re-randomised visitor and a ruined experiment), and an invalid one is
 * never trusted as a bucketing key.
 */
import { describe, it, expect } from 'vitest'
import {
  AVSB_ANON_COOKIE,
  AVSB_ANON_MAX_AGE_SECONDS,
  createAnonId,
  isAnonId,
  resolveAnonId,
  resolveAnonCookieOptions,
} from './anonCookie'

describe('createAnonId', () => {
  it('is unique per call', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createAnonId()))
    expect(ids.size).toBe(50)
  })

  it('produces something isAnonId accepts', () => {
    expect(isAnonId(createAnonId())).toBe(true)
  })
})

describe('isAnonId', () => {
  it('accepts an id this module minted', () => {
    expect(isAnonId('anon_11111111-2222-3333-4444-555555555555')).toBe(true)
  })

  it('rejects values that are not ours', () => {
    expect(isAnonId(undefined)).toBe(false)
    expect(isAnonId(null)).toBe(false)
    expect(isAnonId('')).toBe(false)
    expect(isAnonId('anon_')).toBe(false)
    // A truncated copy is worse than nothing: it would bucket a crowd of
    // visitors onto one key.
    expect(isAnonId('anon_123')).toBe(false)
    expect(isAnonId('some-other-products-cookie')).toBe(false)
  })
})

describe('resolveAnonId', () => {
  it('keeps a valid id, so a returning visitor keeps their variation', () => {
    const existing = 'anon_11111111-2222-3333-4444-555555555555'

    expect(resolveAnonId(existing)).toEqual({ id: existing, isNew: false })
  })

  it('mints a fresh id when there is none', () => {
    const resolved = resolveAnonId(undefined)

    expect(resolved.isNew).toBe(true)
    expect(isAnonId(resolved.id)).toBe(true)
  })

  it('replaces a value it cannot vouch for', () => {
    const resolved = resolveAnonId('garbage')

    expect(resolved.isNew).toBe(true)
    expect(resolved.id).not.toBe('garbage')
  })
})

describe('resolveAnonCookieOptions', () => {
  it('defaults to a year-long, lax, secure, readable cookie', () => {
    expect(resolveAnonCookieOptions()).toEqual({
      name: AVSB_ANON_COOKIE,
      maxAge: AVSB_ANON_MAX_AGE_SECONDS,
      path: '/',
      sameSite: 'lax',
      secure: true,
      // Not httpOnly on purpose: the browser SDK reads this id too.
      httpOnly: false,
    })
  })

  it('carries a domain through for cross-subdomain sharing', () => {
    expect(resolveAnonCookieOptions({ domain: '.example.com' }).domain).toBe('.example.com')
  })

  it('lets every default be overridden', () => {
    expect(
      resolveAnonCookieOptions({
        name: 'my_id',
        maxAgeSeconds: 60,
        path: '/app',
        sameSite: 'strict',
        secure: false,
      }),
    ).toEqual({
      name: 'my_id',
      maxAge: 60,
      path: '/app',
      sameSite: 'strict',
      secure: false,
      httpOnly: false,
    })
  })
})
