import { afterEach, describe, expect, it, vi } from 'vitest'
import { raceInitTimeout } from './initTimeout'

afterEach(() => {
  vi.useRealTimers()
})

describe('raceInitTimeout', () => {
  it('settles with the work and leaves no timer armed when the work wins', async () => {
    vi.useFakeTimers()
    const outcome = await raceInitTimeout(Promise.resolve('datafile'), 10_000)

    expect(outcome).toEqual({ timedOut: false, value: 'datafile' })
    // The bug: this timer stayed armed for the full initTimeout.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles as timed out when the work is slower than the timeout', async () => {
    vi.useFakeTimers()
    const never = new Promise<string>(() => undefined)
    const pending = raceInitTimeout(never, 2_000)

    await vi.advanceTimersByTimeAsync(2_000)
    await expect(pending).resolves.toEqual({ timedOut: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('propagates a rejection and still clears the timer', async () => {
    vi.useFakeTimers()
    const failing = Promise.reject(new Error('dns failure'))

    await expect(raceInitTimeout(failing, 10_000)).rejects.toThrow('dns failure')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unrefs the timer, so it can never be what keeps the process alive', async () => {
    const unref = vi.fn()
    const realSetTimeout = globalThis.setTimeout
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      ms?: number
    ) => {
      const timer = realSetTimeout(callback, ms)
      const realUnref = timer.unref.bind(timer)
      timer.unref = () => {
        unref()
        return realUnref()
      }
      return timer
    }) as typeof setTimeout)

    try {
      await raceInitTimeout(Promise.resolve(true), 10_000)
    } finally {
      spy.mockRestore()
    }
    expect(unref).toHaveBeenCalledTimes(1)
  })
})
