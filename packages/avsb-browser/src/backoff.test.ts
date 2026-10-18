import { afterEach, describe, expect, it, vi } from 'vitest'
import { jitteredInterval, nextBackoff, parseRetryAfter, resetBackoff } from './backoff'

describe('nextBackoff', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('climbs the curve and caps at 60s', () => {
    // Pin jitter to zero so the curve itself is the assertion.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    let state = resetBackoff()
    const delays: number[] = []
    for (let i = 0; i < 8; i++) {
      state = nextBackoff(state)
      delays.push(state.delayMs)
    }

    expect(delays).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000])
    // `resetBackoff()` starts at null and only the loop makes it a state, which
    // the compiler cannot know ran, so this is read through the optional chain
    // rather than asserted away. A null here fails the expectation.
    expect(state?.attempt).toBe(8)
  })

  it('spreads delays around the base rather than firing in lockstep', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const low = nextBackoff({ attempt: 2, delayMs: 0 }).delayMs

    vi.spyOn(Math, 'random').mockReturnValue(1)
    const high = nextBackoff({ attempt: 2, delayMs: 0 }).delayMs

    // Attempt 3 bases at 4000ms with plus or minus 20%.
    expect(low).toBe(3200)
    expect(high).toBe(4800)
    expect(low).toBeLessThan(high)
  })

  it('never schedules a retry sooner than the worst-case first delay', () => {
    // Maximum negative jitter on the first attempt: 1000ms minus 20%.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const first = nextBackoff(null)
    expect(first.delayMs).toBe(800)
    expect(first.attempt).toBe(1)
    expect(first.delayMs).toBeGreaterThanOrEqual(500)
  })

  it('honours a server Retry-After for one attempt but still advances the counter', () => {
    const state = nextBackoff({ attempt: 1, delayMs: 1000 }, 7000)
    expect(state.delayMs).toBe(7000)
    expect(state.attempt).toBe(2)

    // The next miss with no header continues up the curve from attempt 3.
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(nextBackoff(state).delayMs).toBe(4000)
  })
})

describe('parseRetryAfter', () => {
  it('reads the numeric seconds form the workers emit', () => {
    expect(parseRetryAfter('30')).toBe(30_000)
    expect(parseRetryAfter(' 1.5 ')).toBe(1500)
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('returns null for shapes it cannot interpret', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBeNull()
    expect(parseRetryAfter('-5')).toBeNull()
  })
})

describe('jitteredInterval', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('stays inside the requested spread', () => {
    for (const random of [0, 0.25, 0.5, 0.75, 0.999]) {
      vi.spyOn(Math, 'random').mockReturnValue(random)
      const delay = jitteredInterval(60_000, 0.1)
      expect(delay).toBeGreaterThanOrEqual(54_000)
      expect(delay).toBeLessThanOrEqual(66_000)
    }
  })

  it('produces different delays for different draws, so tabs drift apart', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.1)
    const a = jitteredInterval(60_000)
    vi.spyOn(Math, 'random').mockReturnValue(0.9)
    const b = jitteredInterval(60_000)
    expect(a).not.toBe(b)
  })

  it('returns 0 for a non-positive interval instead of a negative timer', () => {
    expect(jitteredInterval(0)).toBe(0)
    expect(jitteredInterval(Number.NaN)).toBe(0)
  })
})
