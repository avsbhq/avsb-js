import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  anonymousId,
  defineContextSchema,
  mergeContext,
  redactAttributes,
} from './context'
import { Browser, Device, Geolocation, PageView } from './visitorData'
import type { SingleContext } from '@avsbhq/core'

describe('defineContextSchema', () => {
  it('builder().setUser() produces a single context', () => {
    const ctx = defineContextSchema({
      user: z.object({ plan: z.enum(['free', 'pro']) }),
    })
      .builder()
      .setUser('u_1', { plan: 'pro' })
      .build()
    expect(ctx).toEqual({ kind: 'user', key: 'u_1', plan: 'pro' })
  })

  it('multiple setKind calls produce a multi-context', () => {
    const ctx = defineContextSchema({
      user: z.object({ plan: z.string() }),
      organization: z.object({ tier: z.number() }),
    })
      .builder()
      .setUser('u_1', { plan: 'pro' })
      .setOrganization('o_42', { tier: 3 })
      .build()
    expect(ctx.kind).toBe('multi')
    expect((ctx as Record<string, SingleContext>).user.key).toBe('u_1')
    expect((ctx as Record<string, SingleContext>).organization.key).toBe('o_42')
  })

  it('build() throws if no kind set', () => {
    const schema = defineContextSchema({})
    expect(() => schema.builder().build()).toThrow(
      /at least one kind/
    )
  })

  it('validate() reports zod issues per kind', () => {
    const schema = defineContextSchema({
      user: z.object({ plan: z.enum(['free', 'pro']) }),
    })
    const bad: SingleContext = { kind: 'user', key: 'u_1', plan: 'nope' }
    const result = schema.validate(bad)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0)
      expect(result.error.issues[0].kind).toBe('user')
    }
  })
})

describe('mergeContext', () => {
  it('merges attributes onto a single context', () => {
    const base: SingleContext = { kind: 'user', key: 'u_1', plan: 'free' }
    const merged = mergeContext(base, { plan: 'pro' } as Partial<SingleContext>)
    expect((merged as SingleContext).plan).toBe('pro')
  })

  it('overlays kinded contexts on a multi-context', () => {
    const base = {
      kind: 'multi',
      user: { kind: 'user', key: 'u_1', plan: 'free' },
    } as const
    const merged = mergeContext(
      base as unknown as Parameters<typeof mergeContext>[0],
      { kind: 'user', key: 'u_1', plan: 'pro' } as Partial<SingleContext>
    )
    const m = merged as unknown as { user: SingleContext }
    expect(m.user.plan).toBe('pro')
  })
})

describe('redactAttributes', () => {
  it('replaces declared private keys with [REDACTED]', () => {
    const base: SingleContext = {
      kind: 'user',
      key: 'u_1',
      email: 'a@b.com',
      plan: 'pro',
    }
    const out = redactAttributes(base, ['email']) as SingleContext
    expect(out.email).toBe('[REDACTED]')
    expect(out.plan).toBe('pro')
  })

  it('honours _meta.privateAttributes', () => {
    const base: SingleContext = {
      kind: 'user',
      key: 'u_1',
      ssn: '123',
      _meta: { privateAttributes: ['ssn'] },
    }
    const out = redactAttributes(base, []) as SingleContext
    expect(out.ssn).toBe('[REDACTED]')
  })

  it('redacts across every sub-context in a multi-context', () => {
    const base = {
      kind: 'multi',
      user: { kind: 'user', key: 'u', email: 'a@b' },
      device: { kind: 'device', key: 'd', model: 'foo' },
    } as const
    const out = redactAttributes(
      base as unknown as Parameters<typeof redactAttributes>[0],
      ['email']
    ) as unknown as { user: SingleContext; device: SingleContext }
    expect(out.user.email).toBe('[REDACTED]')
    expect(out.device.model).toBe('foo')
  })
})

describe('anonymousId', () => {
  it('returns a string prefixed with anon_', () => {
    const id = anonymousId()
    expect(id).toMatch(/^anon_/)
  })

  it('produces distinct ids', () => {
    expect(anonymousId()).not.toBe(anonymousId())
  })
})

describe('visitor data constructors', () => {
  it('Browser() defaults missing fields without throwing', () => {
    const c = Browser({})
    expect(c.kind).toBe('browser')
    expect(typeof c.key).toBe('string')
  })

  it('Device() carries the supplied attrs', () => {
    const c = Device({ id: 'd_1', os: 'iOS', osVersion: '17.4', type: 'mobile' })
    expect(c.key).toBe('d_1')
    expect(c.os).toBe('iOS')
    expect(c.type).toBe('mobile')
  })

  it('Geolocation() composes a country/region/city key', () => {
    const c = Geolocation({ country: 'US', region: 'CA', city: 'SF' })
    expect(c.key).toBe('US/CA/SF')
  })

  it('PageView() returns the supplied URL as key', () => {
    const c = PageView({ url: 'https://app.avsb.cloud/page' })
    expect(c.key).toBe('https://app.avsb.cloud/page')
  })
})
