import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_POLLING_INTERVAL_MS, createPollingLoop } from './polling'

function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => {
      throw new Error('child logger is not used here')
    },
  }
}

/**
 * Shadow `document.visibilityState`. Defining an own property on the
 * instance hides the prototype accessor; the returned function restores it.
 */
function setVisibility(state: 'visible' | 'hidden'): () => void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  return () => {
    delete (document as unknown as Record<string, unknown>)['visibilityState']
  }
}

let restoreVisibility: (() => void) | null = null

beforeEach(() => {
  vi.useFakeTimers()
  // Pin jitter to the midpoint so scheduled delays are exactly the interval.
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

afterEach(() => {
  restoreVisibility?.()
  restoreVisibility = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createPollingLoop', () => {
  it('ticks on the interval and never overlaps two ticks', async () => {
    const onTick = vi.fn(() => Promise.resolve())
    const loop = createPollingLoop({
      intervalMs: 10_000,
      onTick,
      logger: silentLogger(),
    })

    loop.start()
    expect(onTick).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(onTick).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(onTick).toHaveBeenCalledTimes(2)

    loop.stop()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(onTick).toHaveBeenCalledTimes(2)
  })

  it('clamps an interval below the minimum and says so', () => {
    const logger = silentLogger()
    const loop = createPollingLoop({
      intervalMs: 1,
      onTick: vi.fn(),
      logger,
    })

    // `pollingInterval: 1` used to be accepted verbatim: one datafile
    // request per millisecond, from a customer's browser.
    expect(loop.intervalMs()).toBe(MIN_POLLING_INTERVAL_MS)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toContain('minimum')
  })

  it('applies jitter so tabs that started together drift apart', async () => {
    const onTick = vi.fn(() => Promise.resolve())
    // Maximum negative jitter: a 10s interval fires at 9s.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const loop = createPollingLoop({
      intervalMs: 10_000,
      jitter: 0.1,
      onTick,
      logger: silentLogger(),
    })

    loop.start()
    await vi.advanceTimersByTimeAsync(8_999)
    expect(onTick).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    expect(onTick).toHaveBeenCalledTimes(1)

    loop.stop()
  })

  it('pauses while the tab is hidden and refetches when it comes back', async () => {
    const onTick = vi.fn(() => Promise.resolve())
    const loop = createPollingLoop({
      intervalMs: 10_000,
      onTick,
      logger: silentLogger(),
    })
    loop.start()

    restoreVisibility = setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(loop.isPaused()).toBe(true)

    // A backgrounded tab used to keep polling for hours.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(onTick).not.toHaveBeenCalled()

    restoreVisibility()
    restoreVisibility = setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)

    // More than one interval elapsed while hidden, so the tick was owed.
    expect(loop.isPaused()).toBe(false)
    expect(onTick).toHaveBeenCalledTimes(1)

    loop.stop()
  })

  it('does not refetch on becoming visible when barely any time passed', async () => {
    const onTick = vi.fn(() => Promise.resolve())
    const loop = createPollingLoop({
      intervalMs: 60_000,
      onTick,
      logger: silentLogger(),
    })
    loop.start()

    restoreVisibility = setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(1_000)
    restoreVisibility()
    restoreVisibility = setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)

    expect(onTick).not.toHaveBeenCalled()
    loop.stop()
  })

  it('refetches on window focus, throttled to the minimum interval', async () => {
    const onTick = vi.fn(() => Promise.resolve())
    const loop = createPollingLoop({
      intervalMs: 60_000,
      onTick,
      logger: silentLogger(),
    })
    loop.start()

    // Immediately after start, focus is inside the throttle window.
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(onTick).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(MIN_POLLING_INTERVAL_MS + 1)
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(onTick).toHaveBeenCalledTimes(1)

    loop.stop()
  })

  it('removes its listeners on stop', async () => {
    const onTick = vi.fn(() => Promise.resolve())
    const loop = createPollingLoop({
      intervalMs: 60_000,
      onTick,
      logger: silentLogger(),
    })
    loop.start()
    loop.stop()

    restoreVisibility = setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(120_000)

    expect(onTick).not.toHaveBeenCalled()
    expect(loop.isPaused()).toBe(false)
  })

  it('ignores visibility and focus when those behaviours are switched off', async () => {
    const onTick = vi.fn(() => Promise.resolve())
    const loop = createPollingLoop({
      intervalMs: 10_000,
      pauseWhenHidden: false,
      refetchOnFocus: false,
      onTick,
      logger: silentLogger(),
    })
    loop.start()

    restoreVisibility = setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(loop.isPaused()).toBe(false)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(onTick).toHaveBeenCalledTimes(1)

    loop.stop()
  })
})
