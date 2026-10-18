import { describe, expect, it } from 'vitest'
import type { ExposureEvent } from '@avsbhq/core'
import { redactExposure } from './exposure'

function exposure(overrides: Partial<ExposureEvent> = {}): ExposureEvent {
  return {
    eventId: 'e_1',
    visitorId: 'u_1',
    experimentId: 'rule_1',
    variationId: 'var_on',
    eventName: 'flag_exposure',
    revenue: null,
    timestamp: 1_700_000_000_000,
    pageUrl: '',
    properties: { flagKey: 'checkout-v2', flagId: 'flag_1' },
    attributes: { plan: 'pro', email: 'ada@example.com' },
    ...overrides,
  }
}

describe('redactExposure', () => {
  it('removes a private attribute from the attributes map', () => {
    const out = redactExposure(exposure(), ['email'])

    expect(out.attributes).toEqual({ plan: 'pro' })
    expect(out.attributes?.email).toBeUndefined()
  })

  it('leaves non-private attributes and the decision metadata alone', () => {
    const out = redactExposure(exposure(), ['email'])

    expect(out.attributes?.plan).toBe('pro')
    expect(out.properties).toEqual({ flagKey: 'checkout-v2', flagId: 'flag_1' })
    expect(out.visitorId).toBe('u_1')
    expect(out.experimentId).toBe('rule_1')
    expect(out.eventId).toBe('e_1')
  })

  it('removes every named attribute, not just the first', () => {
    const out = redactExposure(
      exposure({ attributes: { email: 'a@b.com', phone: '555', plan: 'pro' } }),
      ['email', 'phone'],
    )

    expect(out.attributes).toEqual({ plan: 'pro' })
  })

  it('also cleans a decision property that echoes an attribute name', () => {
    const out = redactExposure(
      exposure({ properties: { flagKey: 'checkout-v2', email: 'ada@example.com' } }),
      ['email'],
    )

    expect(out.properties).toEqual({ flagKey: 'checkout-v2' })
  })

  it('does not mutate the event it was given', () => {
    const original = exposure()
    redactExposure(original, ['email'])

    expect(original.attributes).toEqual({ plan: 'pro', email: 'ada@example.com' })
  })

  it('returns the same object when nothing is private', () => {
    const original = exposure()
    expect(redactExposure(original, [])).toBe(original)
    expect(redactExposure(original, undefined)).toBe(original)
  })

  it('returns the same object when the private names are not present', () => {
    const original = exposure()
    expect(redactExposure(original, ['ssn'])).toBe(original)
  })

  it('handles an event with no attributes at all', () => {
    const original = exposure({ attributes: undefined })
    const out = redactExposure(original, ['email'])

    expect(out).toBe(original)
    expect(out.attributes).toBeUndefined()
  })
})
