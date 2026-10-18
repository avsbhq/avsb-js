import { describe, expect, it } from 'vitest'
import { createOverrideStore } from './overrideStore'

describe('createOverrideStore', () => {
  it('resolves nothing for a flag with no overrides', () => {
    const store = createOverrideStore()
    expect(store.resolve('checkout-v2', 'u_1')).toBeUndefined()
    expect(store.size()).toBe(0)
  })

  it('resolves a per-context override for that context only', () => {
    const store = createOverrideStore()
    store.setForContext('checkout-v2', 'u_qa', 'on')

    expect(store.resolve('checkout-v2', 'u_qa')).toBe('on')
    expect(store.resolve('checkout-v2', 'u_other')).toBeUndefined()
  })

  it('resolves a global override for every context', () => {
    const store = createOverrideStore()
    store.setGlobal('checkout-v2', 'off')

    expect(store.resolve('checkout-v2', 'u_1')).toBe('off')
    expect(store.resolve('checkout-v2', 'u_2')).toBe('off')
  })

  it('prefers a per-context override over a global one', () => {
    const store = createOverrideStore()
    store.setGlobal('checkout-v2', 'off')
    store.setForContext('checkout-v2', 'u_qa', 'on')

    expect(store.resolve('checkout-v2', 'u_qa')).toBe('on')
    expect(store.resolve('checkout-v2', 'u_1')).toBe('off')
  })

  it('keys per-context overrides by kind, so two kinds with the same key do not collide', () => {
    const store = createOverrideStore()
    store.setForContext('checkout-v2', 'acme', 'on', 'organization')

    expect(store.resolve('checkout-v2', 'acme', 'organization')).toBe('on')
    expect(store.resolve('checkout-v2', 'acme')).toBeUndefined()
  })

  it('clearing a per-context override falls back to the global one', () => {
    const store = createOverrideStore()
    store.setGlobal('checkout-v2', 'off')
    store.setForContext('checkout-v2', 'u_qa', 'on')

    store.clearForContext('checkout-v2', 'u_qa')

    expect(store.resolve('checkout-v2', 'u_qa')).toBe('off')
  })

  it('clearing the global override leaves per-context ones intact', () => {
    const store = createOverrideStore()
    store.setGlobal('checkout-v2', 'off')
    store.setForContext('checkout-v2', 'u_qa', 'on')

    store.clearGlobal('checkout-v2')

    expect(store.resolve('checkout-v2', 'u_qa')).toBe('on')
    expect(store.resolve('checkout-v2', 'u_1')).toBeUndefined()
  })

  it('drops the flag entry once nothing is left, so size reflects reality', () => {
    const store = createOverrideStore()
    store.setForContext('checkout-v2', 'u_qa', 'on')
    expect(store.size()).toBe(1)

    store.clearForContext('checkout-v2', 'u_qa')
    expect(store.size()).toBe(0)
  })

  it('clearAll removes every flag', () => {
    const store = createOverrideStore()
    store.setGlobal('a', 'on')
    store.setForContext('b', 'u_1', 'off')

    store.clearAll()

    expect(store.size()).toBe(0)
    expect(store.resolve('a', 'u_1')).toBeUndefined()
    expect(store.resolve('b', 'u_1')).toBeUndefined()
  })

  it('clearing something that was never set is a no-op, not a crash', () => {
    const store = createOverrideStore()
    expect(() => store.clearForContext('nope', 'u_1')).not.toThrow()
    expect(() => store.clearGlobal('nope')).not.toThrow()
  })
})
