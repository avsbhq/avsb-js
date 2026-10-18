import { describe, expect, it } from 'vitest'
import { TestData } from './TestData'
import { createMockClient } from './createMockClient'
import { createMockFlagResolver, flagsFromTestData } from './mockFlags'

describe('flagsFromTestData', () => {
  it('maps the fallthrough variation onto the flags map', () => {
    const entry = TestData.flag('checkout-v2')
      .booleanFlag()
      .fallthroughVariation(false)
      .build()

    expect(flagsFromTestData([entry]).flags).toEqual({ 'checkout-v2': false })
  })

  it('maps a per-user variation onto flagsByUser, keyed flagKey:userKey', () => {
    const entry = TestData.flag('checkout-v2')
      .booleanFlag()
      .variationForUser('u_paying', true)
      .fallthroughVariation(false)
      .build()

    const state = flagsFromTestData([entry])
    expect(state.flagsByUser['checkout-v2:u_paying']).toBe(true)
    expect(state.flags['checkout-v2']).toBe(false)
  })

  it('maps a context-kind variation by its key', () => {
    const entry = TestData.flag('enterprise-dashboard')
      .booleanFlag()
      .variationForContext('organization', 'org_1', true)
      .fallthroughVariation(false)
      .build()

    expect(flagsFromTestData([entry]).flagsByUser['enterprise-dashboard:org_1']).toBe(
      true
    )
  })

  it('merges several entries into one option object', () => {
    const state = flagsFromTestData([
      TestData.flag('a').booleanFlag().fallthroughVariation(true).build(),
      TestData.flag('b').stringFlag().fallthroughVariation('light').build(),
    ])

    expect(state.flags).toEqual({ a: true, b: 'light' })
  })

  it('drives createMockClient directly, which the READMEs used to get wrong', () => {
    // The old, broken quickstart was `createMockClient({ flags: [td.build()] })`:
    // an array where a map belongs, so every flag served its default.
    const entry = TestData.flag('checkout-v2')
      .booleanFlag()
      .variationForUser('u_paying', true)
      .fallthroughVariation(false)
      .build()

    const client = createMockClient({
      ...flagsFromTestData([entry]),
      context: { kind: 'user', key: 'u_paying' },
    })

    expect(client.getBoolFlag('checkout-v2', false).value).toBe(true)

    client.identify({ kind: 'user', key: 'u_other' })
    expect(client.getBoolFlag('checkout-v2', false).value).toBe(false)
  })

  it('produces an empty state for no entries', () => {
    expect(flagsFromTestData([])).toEqual({ flags: {}, flagsByUser: {} })
  })
})

describe('createMockFlagResolver', () => {
  const state = {
    flags: { 'checkout-v2': false, theme: 'light' },
    flagsByUser: { 'checkout-v2:u_paying': true },
  }

  it('prefers a per-context value over the fallthrough', () => {
    const resolver = createMockFlagResolver(state)
    expect(
      resolver.resolve('checkout-v2', false, { kind: 'user', key: 'u_paying' })
    ).toEqual({ value: true, found: true })
  })

  it('falls back to the flags map for another context', () => {
    const resolver = createMockFlagResolver(state)
    expect(
      resolver.resolve('checkout-v2', true, { kind: 'user', key: 'u_other' })
    ).toEqual({ value: false, found: true })
  })

  it('reports found: false for a key the fixture never declared', () => {
    const resolver = createMockFlagResolver(state)
    expect(
      resolver.resolve('unknown', 'fallback', { kind: 'user', key: 'u_1' })
    ).toEqual({ value: 'fallback', found: false })
  })

  it('reads the user sub-context key under multi-context', () => {
    const resolver = createMockFlagResolver(state)
    const multi = {
      kind: 'multi' as const,
      user: { kind: 'user', key: 'u_paying' },
      organization: { kind: 'organization', key: 'org_1' },
    }
    expect(resolver.keyOf(multi)).toBe('u_paying')
    expect(resolver.resolve('checkout-v2', false, multi).value).toBe(true)
  })

  it('lists the keys answerable for a context, including its per-context ones', () => {
    const resolver = createMockFlagResolver(state)
    expect(resolver.keysFor({ kind: 'user', key: 'u_paying' }).sort()).toEqual([
      'checkout-v2',
      'theme',
    ])
  })

  it('does not mutate the state object it was given', () => {
    const original = { flags: { a: 1 }, flagsByUser: {} }
    const resolver = createMockFlagResolver(original)
    resolver.set('a', 2)
    expect(original.flags.a).toBe(1)
  })
})
