import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  debounce,
  once,
  retry,
  sleep,
  throttle,
  withDeadline,
  withTimeout,
} from './timing'
import { createRegistry } from './registry'

describe('once', () => {
  it('invokes the function exactly once and caches the result', () => {
    const fn = vi.fn(() => 'hello')
    const wrapped = once(fn)
    expect(wrapped()).toBe('hello')
    expect(wrapped()).toBe('hello')
    expect(wrapped()).toBe('hello')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('preserves the first argument set', () => {
    const fn = vi.fn((x: number) => x * 2)
    const wrapped = once(fn)
    expect(wrapped(3)).toBe(6)
    expect(wrapped(10)).toBe(6)
  })
})

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('only fires after the quiet period', () => {
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d()
    d()
    d()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('cancel() prevents the pending fire', () => {
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d()
    d.cancel()
    vi.advanceTimersByTime(200)
    expect(fn).not.toHaveBeenCalled()
  })

  it('registers a teardown with the registry', () => {
    const reg = createRegistry()
    const fn = vi.fn()
    const d = debounce(fn, 100, reg)
    d()
    reg.drain()
    vi.advanceTimersByTime(200)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('throttle', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires on the leading edge', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t()
    expect(fn).toHaveBeenCalledOnce()
  })

  it('coalesces a trailing call into one fire', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t()
    t()
    t()
    expect(fn).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('cancel() drops the trailing call', () => {
    const fn = vi.fn()
    const t = throttle(fn, 100)
    t()
    t()
    t.cancel()
    vi.advanceTimersByTime(200)
    expect(fn).toHaveBeenCalledOnce()
  })
})

describe('sleep', () => {
  it('resolves after the given delay', async () => {
    const start = Date.now()
    await sleep(20)
    expect(Date.now() - start).toBeGreaterThanOrEqual(15)
  })
})

describe('retry', () => {
  it('returns the value on first success', async () => {
    const fn = vi.fn(async () => 'ok')
    expect(await retry(fn)).toBe('ok')
    expect(fn).toHaveBeenCalledOnce()
  })

  it('retries the configured number of attempts', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(retry(fn, { attempts: 3, delay: 1 })).rejects.toThrow('boom')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('returns the value once a retry succeeds', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls++
      if (calls < 3) throw new Error('not yet')
      return 'finally'
    })
    expect(await retry(fn, { attempts: 5, delay: 1 })).toBe('finally')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('opens the circuit breaker after threshold consecutive failures', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(
      retry(fn, { attempts: 5, delay: 1, circuitBreakerThreshold: 2 })
    ).rejects.toThrow()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})

describe('withTimeout', () => {
  it('resolves with the inner value if it completes in time', async () => {
    expect(
      await withTimeout(Promise.resolve('done'), 100)
    ).toBe('done')
  })

  it('rejects when the inner promise stalls past the deadline', async () => {
    await expect(
      withTimeout(new Promise(() => undefined), 10)
    ).rejects.toThrow(/timed out/)
  })
})

describe('withDeadline', () => {
  it('rejects if the deadline has already passed', async () => {
    await expect(
      withDeadline(Promise.resolve('x'), Date.now() - 1)
    ).rejects.toThrow(/Deadline/)
  })

  it('resolves when inside the deadline window', async () => {
    expect(
      await withDeadline(Promise.resolve('x'), Date.now() + 1000)
    ).toBe('x')
  })
})
