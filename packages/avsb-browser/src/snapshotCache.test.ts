import { describe, expect, it, vi } from 'vitest'
import { createFlag } from '@avsbhq/core'
import type { Flag } from '@avsbhq/core'
import { createSnapshotCache } from './snapshotCache'

function flagOf<T>(value: T, reason = 'test'): Flag<T> {
  return createFlag<T>({
    value,
    variationKey: 'on',
    source: 'rule',
    ruleId: 'rule-1',
    ruleType: 'ab_test',
    reasons: [reason],
  })
}

describe('createSnapshotCache', () => {
  it('returns the identical object for repeated reads of the same key', () => {
    const cache = createSnapshotCache()
    const compute = vi.fn(() => flagOf(true))

    const first = cache.get('checkout', 'any', false, compute)
    const second = cache.get('checkout', 'any', false, compute)
    const third = cache.get('checkout', 'any', false, compute)

    // The whole point: React compares snapshots by identity, so a fresh
    // object per call is the infinite-render bug this cache exists to kill.
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('keys on the default value so two callers with different defaults do not collide', () => {
    const cache = createSnapshotCache()

    const withFalse = cache.get('missing', 'any', false, () => flagOf(false))
    const withTrue = cache.get('missing', 'any', true, () => flagOf(true))

    expect(withFalse.value).toBe(false)
    expect(withTrue.value).toBe(true)
    // And each stays stable on its own key.
    expect(cache.get('missing', 'any', false, () => flagOf(false))).toBe(withFalse)
    expect(cache.get('missing', 'any', true, () => flagOf(true))).toBe(withTrue)
  })

  it('collapses structurally equal object defaults to one entry', () => {
    const cache = createSnapshotCache()
    const compute = vi.fn(() => flagOf({ timeout: 5000 }))

    // A component that inlines its default builds a new object every render.
    const first = cache.get('config', 'json', { timeout: 5000 }, compute)
    const second = cache.get('config', 'json', { timeout: 5000 }, compute)

    expect(second).toBe(first)
    expect(compute).toHaveBeenCalledTimes(1)
    expect(cache.size()).toBe(1)
  })

  it('keys unserialisable defaults by identity so they stay stable too', () => {
    const cache = createSnapshotCache()
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    const compute = vi.fn(() => flagOf(cyclic))

    const first = cache.get('cyclic', 'json', cyclic, compute)
    const second = cache.get('cyclic', 'json', cyclic, compute)

    expect(second).toBe(first)
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('separates typed variants from the generic getter for the same key', () => {
    const cache = createSnapshotCache()

    const generic = cache.get('flag', 'any', false, () => flagOf(true))
    const typed = cache.get('flag', 'boolean', false, () => flagOf(false))

    // A typed getter can substitute the default after its runtime type
    // check, so it cannot share the generic entry.
    expect(typed).not.toBe(generic)
    expect(cache.size()).toBe(2)
  })

  it('recomputes after invalidateKey, and only for that key', () => {
    const cache = createSnapshotCache()
    const computeA = vi.fn(() => flagOf('a'))
    const computeB = vi.fn(() => flagOf('b'))

    const a1 = cache.get('a', 'any', '', computeA)
    const b1 = cache.get('b', 'any', '', computeB)

    cache.invalidateKey('a')

    const a2 = cache.get('a', 'any', '', computeA)
    const b2 = cache.get('b', 'any', '', computeB)

    expect(a2).not.toBe(a1)
    expect(b2).toBe(b1)
    expect(computeA).toHaveBeenCalledTimes(2)
    expect(computeB).toHaveBeenCalledTimes(1)
  })

  it('drops everything on clear and reports its size', () => {
    const cache = createSnapshotCache()
    cache.get('a', 'any', '', () => flagOf('a'))
    cache.get('b', 'any', '', () => flagOf('b'))
    expect(cache.size()).toBe(2)

    cache.clear()

    expect(cache.size()).toBe(0)
    const compute = vi.fn(() => flagOf('a'))
    cache.get('a', 'any', '', compute)
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('stays bounded when a caller keys a new entry on every read', () => {
    const cache = createSnapshotCache()
    for (let i = 0; i < 600; i++) {
      cache.get(`flag-${i}`, 'any', i, () => flagOf(i))
    }
    // A long-lived SPA must not grow this map without limit.
    expect(cache.size()).toBeLessThanOrEqual(500)
  })
})
