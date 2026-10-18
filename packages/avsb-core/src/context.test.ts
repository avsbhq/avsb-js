import { describe, it, expect } from 'vitest'
import {
  isMultiContext,
  getContextByKind,
  toLegacyEvalContext,
  userContext,
  bucketingKey,
  contextSummary,
  privateAttributesFrom,
} from './context'
import type { EvalContext, MultiContext } from './types'

describe('isMultiContext', () => {
  it('returns true for a multi-context container', () => {
    const ctx: EvalContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u_1' },
      organization: { kind: 'organization', key: 'o_1' },
    }
    expect(isMultiContext(ctx)).toBe(true)
  })

  it('returns false for a single user context', () => {
    expect(isMultiContext({ kind: 'user', key: 'u_1' })).toBe(false)
  })

  it('returns false for a single device context', () => {
    expect(isMultiContext({ kind: 'device', key: 'd_abc' })).toBe(false)
  })
})

describe('getContextByKind', () => {
  it('returns the user sub-context from a multi-context', () => {
    const ctx: EvalContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u_1', plan: 'pro' },
      organization: { kind: 'organization', key: 'o_1' },
    }
    expect(getContextByKind(ctx, 'user')).toEqual({
      kind: 'user',
      key: 'u_1',
      plan: 'pro',
    })
  })

  it('returns the context itself when it matches the requested kind', () => {
    const ctx: EvalContext = { kind: 'user', key: 'u_1' }
    expect(getContextByKind(ctx, 'user')).toBe(ctx)
  })

  it('returns null when the kind is absent from a single context', () => {
    const ctx: EvalContext = { kind: 'user', key: 'u_1' }
    expect(getContextByKind(ctx, 'organization')).toBeNull()
  })

  it('returns null when the kind is absent from a multi-context', () => {
    const ctx: EvalContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u_1' },
    }
    expect(getContextByKind(ctx, 'device')).toBeNull()
  })
})

describe('toLegacyEvalContext', () => {
  it('maps a single user context to userId + flat attributes', () => {
    const out = toLegacyEvalContext({
      kind: 'user',
      key: 'u_1',
      plan: 'pro',
      country: 'US',
    })
    expect(out.attributes['userId']).toBe('u_1')
    expect(out.attributes['plan']).toBe('pro')
    expect(out.attributes['country']).toBe('US')
  })

  it('excludes reserved keys from the flat attributes', () => {
    const out = toLegacyEvalContext({
      kind: 'user',
      key: 'u_1',
      name: 'Alice',
      _meta: { anonymous: true },
      plan: 'pro',
    })
    expect(out.attributes['kind']).toBeUndefined()
    expect(out.attributes['_meta']).toBeUndefined()
    expect(out.attributes['name']).toBe('Alice')
    expect(out.attributes['userId']).toBe('u_1')
  })

  it('multi-context: flattens user sub-context and exposes other kinds under dotted prefixes', () => {
    const ctx: MultiContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'u_1', plan: 'pro' },
      organization: {
        kind: 'organization',
        key: 'o_42',
        tier: 'enterprise',
      },
    }
    const out = toLegacyEvalContext(ctx)
    expect(out.attributes['userId']).toBe('u_1')
    expect(out.attributes['plan']).toBe('pro')
    expect(out.attributes['organization.key']).toBe('o_42')
    expect(out.attributes['organization.tier']).toBe('enterprise')
  })

  it('multi-context without a user sub-context still flattens other kinds', () => {
    const ctx: MultiContext = {
      kind: 'multi',
      device: { kind: 'device', key: 'd_abc', os: 'ios' },
    }
    const out = toLegacyEvalContext(ctx)
    expect(out.attributes['device.key']).toBe('d_abc')
    expect(out.attributes['device.os']).toBe('ios')
  })
})

describe('bucketingKey', () => {
  it('returns the single context key', () => {
    expect(bucketingKey({ kind: 'user', key: 'u_1' })).toBe('u_1')
  })

  it('returns the user sub-context key from a multi-context', () => {
    expect(
      bucketingKey({
        kind: 'multi',
        user: { kind: 'user', key: 'u_1' },
        organization: { kind: 'organization', key: 'o_1' },
      })
    ).toBe('u_1')
  })

  it('returns the named kind from a multi-context', () => {
    expect(
      bucketingKey(
        {
          kind: 'multi',
          user: { kind: 'user', key: 'u_1' },
          organization: { kind: 'organization', key: 'o_1' },
        },
        'organization'
      )
    ).toBe('o_1')
  })

  it('returns empty string when no matching kind exists', () => {
    expect(bucketingKey({ kind: 'device', key: 'd_1' }, 'user')).toBe('')
  })
})

describe('contextSummary', () => {
  it('returns one entry for a single context', () => {
    expect(contextSummary({ kind: 'user', key: 'u_1' })).toEqual([
      { kind: 'user', key: 'u_1' },
    ])
  })

  it('returns kind+key for every sub-context in multi', () => {
    const out = contextSummary({
      kind: 'multi',
      user: { kind: 'user', key: 'u_1', plan: 'pro' },
      organization: { kind: 'organization', key: 'o_1', tier: 'enterprise' },
    })
    expect(out).toContainEqual({ kind: 'user', key: 'u_1' })
    expect(out).toContainEqual({ kind: 'organization', key: 'o_1' })
    expect(out).toHaveLength(2)
  })

  it('omits attributes from the summary', () => {
    const out = contextSummary({
      kind: 'user',
      key: 'u_1',
      plan: 'pro',
      country: 'US',
    })
    expect(out[0]).toEqual({ kind: 'user', key: 'u_1' })
    expect(Object.keys(out[0])).toEqual(['kind', 'key'])
  })
})

describe('privateAttributesFrom', () => {
  it('extracts privateAttributes from a single context _meta', () => {
    const out = privateAttributesFrom({
      kind: 'user',
      key: 'u_1',
      _meta: { privateAttributes: ['email', 'ssn'] },
    })
    expect(out.has('email')).toBe(true)
    expect(out.has('ssn')).toBe(true)
    expect(out.size).toBe(2)
  })

  it('aggregates privateAttributes across multi-context sub-contexts', () => {
    const out = privateAttributesFrom({
      kind: 'multi',
      user: {
        kind: 'user',
        key: 'u_1',
        _meta: { privateAttributes: ['email'] },
      },
      organization: {
        kind: 'organization',
        key: 'o_1',
        _meta: { privateAttributes: ['internalId'] },
      },
    })
    expect(out.has('email')).toBe(true)
    expect(out.has('internalId')).toBe(true)
  })

  it('returns empty set when no _meta is present', () => {
    expect(
      privateAttributesFrom({ kind: 'user', key: 'u_1' }).size
    ).toBe(0)
  })
})

describe('userContext', () => {
  it('builds a {kind:user, key} context', () => {
    expect(userContext('u_1')).toEqual({ kind: 'user', key: 'u_1' })
  })

  it('attaches attributes when provided', () => {
    expect(userContext('u_1', { plan: 'pro', country: 'US' })).toEqual({
      kind: 'user',
      key: 'u_1',
      plan: 'pro',
      country: 'US',
    })
  })
})
