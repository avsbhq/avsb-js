import { describe, expect, it, vi } from 'vitest'
import { FallbackChain, circuitBreaker } from './resilience'

describe('FallbackChain', () => {
  it('returns null when every layer yields null', async () => {
    const chain = new FallbackChain<string>()
      .add({ name: 'a', resolve: () => null })
      .add({ name: 'b', resolve: () => undefined })
    expect(await chain.run()).toBeNull()
  })

  it('returns the first layer that resolves a value, with source attribution', async () => {
    const chain = new FallbackChain<string>()
      .add({ name: 'default', resolve: () => 'fallback' })
      .add({ name: 'live', resolve: () => 'never reached' })
    const result = await chain.run()
    expect(result).toEqual({ value: 'fallback', source: 'default' })
  })

  it('skips a layer that throws and continues to the next', async () => {
    const chain = new FallbackChain<string>()
      .add({
        name: 'broken',
        resolve: () => {
          throw new Error('boom')
        },
      })
      .add({ name: 'fallback', resolve: () => 'ok' })
    expect(await chain.run()).toEqual({ value: 'ok', source: 'fallback' })
  })

  it('awaits async layers in order', async () => {
    const order: string[] = []
    const chain = new FallbackChain<string>()
      .add({
        name: 'a',
        resolve: async () => {
          order.push('a')
          return null
        },
      })
      .add({
        name: 'b',
        resolve: async () => {
          order.push('b')
          return 'b-val'
        },
      })
      .add({
        name: 'c',
        resolve: async () => {
          order.push('c')
          return 'c-val'
        },
      })
    const r = await chain.run()
    expect(r?.source).toBe('b')
    expect(order).toEqual(['a', 'b'])
  })
})

describe('circuitBreaker', () => {
  it('passes through when underlying fn succeeds', async () => {
    const fn = vi.fn(async () => 'ok')
    const wrapped = circuitBreaker(fn, { threshold: 2 })
    expect(await wrapped()).toBe('ok')
  })

  it('opens after threshold consecutive failures and short-circuits', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom')
    })
    const wrapped = circuitBreaker(fn, { threshold: 2, resetTimeoutMs: 60_000 })
    await expect(wrapped()).rejects.toThrow('boom')
    await expect(wrapped()).rejects.toThrow('boom')
    // breaker now open — fn should not be called again
    await expect(wrapped()).rejects.toThrow(/Circuit breaker is open/)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('resets the failure counter on success', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls === 1 || calls === 3) throw new Error(`fail-${calls}`)
      return 'ok'
    })
    const wrapped = circuitBreaker(fn, { threshold: 2 })
    await expect(wrapped()).rejects.toThrow('fail-1')
    expect(await wrapped()).toBe('ok') // resets counter
    await expect(wrapped()).rejects.toThrow('fail-3') // 1st fresh failure
    // breaker NOT open yet — succeeds again on next call
    expect(await wrapped()).toBe('ok')
  })

  it('uses the fallback when open', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom')
    })
    const fallback = vi.fn(() => 'fallback-value') as unknown as <A extends unknown[], R>(...a: A) => R
    const wrapped = circuitBreaker(fn, {
      threshold: 1,
      resetTimeoutMs: 60_000,
      fallback,
    })
    await expect(wrapped()).rejects.toThrow('boom')
    // now open — second call returns fallback
    expect(await wrapped()).toBe('fallback-value')
    expect(fallback).toHaveBeenCalled()
  })
})
