import { describe, expect, it } from 'vitest'
import { MAX_LIST_LIMIT, validateLimit } from './listOptions.js'

describe('validateLimit', () => {
  it('leaves an unset flag unset', () => {
    expect(validateLimit(undefined)).toEqual({ ok: true, limit: undefined })
  })

  it('accepts a whole number inside the range', () => {
    expect(validateLimit('25')).toEqual({ ok: true, limit: 25 })
    expect(validateLimit(String(MAX_LIST_LIMIT))).toEqual({ ok: true, limit: MAX_LIST_LIMIT })
  })

  it('refuses text instead of sending limit=NaN to the platform', () => {
    const result = validateLimit('abc')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('Invalid --limit "abc"')
  })

  it('refuses zero, negatives, and fractions', () => {
    expect(validateLimit('0').ok).toBe(false)
    expect(validateLimit('-5').ok).toBe(false)
    expect(validateLimit('2.5').ok).toBe(false)
  })

  it('refuses a value above the ceiling, naming it', () => {
    const result = validateLimit('101')

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('between 1 and 100')
  })

  it('takes a per-route ceiling, because the older CLI routes allow more', () => {
    expect(validateLimit('500', 500)).toEqual({ ok: true, limit: 500 })
    expect(validateLimit('501', 500).ok).toBe(false)
  })
})
