import { describe, it, expect } from 'vitest'
import { createTestContext, createMultiTestContext } from './context'

describe('createTestContext — defaults', () => {
  it('returns kind=user by default', () => {
    const ctx = createTestContext()
    expect(ctx.kind).toBe('user')
  })

  it('returns key=test-user by default', () => {
    const ctx = createTestContext()
    expect(ctx.key).toBe('test-user')
  })

  it('produces a valid SingleContext shape', () => {
    const ctx = createTestContext()
    expect(typeof ctx.kind).toBe('string')
    expect(typeof ctx.key).toBe('string')
  })
})

describe('createTestContext — overrides', () => {
  it('overrides key', () => {
    const ctx = createTestContext({ key: 'alice' })
    expect(ctx.key).toBe('alice')
  })

  it('overrides kind', () => {
    const ctx = createTestContext({ kind: 'organization', key: 'acme' })
    expect(ctx.kind).toBe('organization')
    expect(ctx.key).toBe('acme')
  })

  it('merges additional attributes', () => {
    const ctx = createTestContext({ key: 'bob', plan: 'enterprise' })
    expect((ctx as typeof ctx & { plan: string }).plan).toBe('enterprise')
  })

  it('does not mutate the overrides object', () => {
    const overrides = { key: 'carol' }
    createTestContext(overrides)
    expect(overrides).toEqual({ key: 'carol' })
  })
})

describe('createMultiTestContext — structure', () => {
  it('includes kind=multi discriminator', () => {
    const ctx = createMultiTestContext({
      user: { kind: 'user', key: 'alice' },
    })
    expect(ctx.kind).toBe('multi')
  })

  it('includes all provided sub-contexts', () => {
    const ctx = createMultiTestContext({
      user: { kind: 'user', key: 'alice' },
      organization: { kind: 'organization', key: 'acme' },
    })
    expect((ctx as Record<string, unknown>)['user']).toBeDefined()
    expect((ctx as Record<string, unknown>)['organization']).toBeDefined()
  })

  it('preserves sub-context key values', () => {
    const ctx = createMultiTestContext({
      user: { kind: 'user', key: 'bob' },
    })
    const user = (ctx as Record<string, unknown>)['user'] as { key: string }
    expect(user.key).toBe('bob')
  })

  it('empty parts map still has kind=multi', () => {
    const ctx = createMultiTestContext({})
    expect(ctx.kind).toBe('multi')
  })

  it('does not mutate the input parts', () => {
    const parts = { user: { kind: 'user' as const, key: 'alice' } }
    createMultiTestContext(parts)
    expect(parts.user.key).toBe('alice')
  })
})
