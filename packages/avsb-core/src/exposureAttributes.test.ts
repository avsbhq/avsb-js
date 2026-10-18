import { describe, it, expect } from 'vitest'
import { buildExposureAttributes } from './exposureAttributes'
import type { LegacyEvalContext, FlagDatafile } from './types'

function ctx(attributes: Record<string, unknown>): LegacyEvalContext {
  return { attributes }
}

function dfWith(keys: string[] | undefined): Pick<FlagDatafile, 'registeredAttributes'> {
  return { registeredAttributes: keys }
}

describe('buildExposureAttributes', () => {
  it('returns undefined when datafile has no registered attributes', () => {
    expect(buildExposureAttributes(ctx({ plan: 'pro' }), dfWith(undefined))).toBeUndefined()
    expect(buildExposureAttributes(ctx({ plan: 'pro' }), dfWith([]))).toBeUndefined()
  })

  it('drops keys that are not registered', () => {
    const out = buildExposureAttributes(
      ctx({ plan: 'pro', password: 'sekret', email: 'a@b.com' }),
      dfWith(['plan'])
    )
    expect(out).toEqual({ plan: 'pro' })
  })

  it('returns only the registered subset when context has both registered + unregistered keys', () => {
    const out = buildExposureAttributes(
      ctx({ plan: 'pro', country: 'US', userId: 'u_123', password: 'x' }),
      dfWith(['plan', 'country'])
    )
    expect(out).toEqual({ plan: 'pro', country: 'US' })
  })

  it('skips undefined and null values', () => {
    const out = buildExposureAttributes(
      ctx({ plan: undefined, country: null, deviceType: 'mobile' }),
      dfWith(['plan', 'country', 'deviceType'])
    )
    expect(out).toEqual({ deviceType: 'mobile' })
  })

  it('stringifies number and boolean primitives', () => {
    const out = buildExposureAttributes(
      ctx({ teamSize: 50, isPro: true, plan: 'enterprise' }),
      dfWith(['teamSize', 'isPro', 'plan'])
    )
    expect(out).toEqual({ teamSize: '50', isPro: 'true', plan: 'enterprise' })
  })

  it('JSON-stringifies object values', () => {
    const out = buildExposureAttributes(
      ctx({ tags: ['a', 'b'], meta: { foo: 1 } }),
      dfWith(['tags', 'meta'])
    )
    expect(out).toEqual({
      tags: '["a","b"]',
      meta: '{"foo":1}',
    })
  })

  it('returns undefined when none of the registered keys are present in context', () => {
    const out = buildExposureAttributes(
      ctx({ password: 'x', email: 'a@b.com' }),
      dfWith(['plan', 'country'])
    )
    expect(out).toBeUndefined()
  })

  it('returns undefined when registered keys are present but every value is null/undefined', () => {
    const out = buildExposureAttributes(
      ctx({ plan: undefined, country: null }),
      dfWith(['plan', 'country'])
    )
    expect(out).toBeUndefined()
  })

  it('preserves empty-string values (they are valid stringified data)', () => {
    const out = buildExposureAttributes(ctx({ plan: '' }), dfWith(['plan']))
    expect(out).toEqual({ plan: '' })
  })
})
