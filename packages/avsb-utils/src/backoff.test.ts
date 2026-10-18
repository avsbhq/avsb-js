import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  nextBackoff,
  resetBackoff,
  parseRetryAfter,
  jitteredInterval,
  BACKOFF_DEFAULTS,
  type BackoffState,
} from './backoff'

describe('nextBackoff', () => {
  beforeEach(() => {
    // Pin Math.random() at 0.5 so the jitter is the midpoint (zero offset).
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => vi.restoreAllMocks())

  it('starts the curve at 1s on the first attempt', () => {
    const r = nextBackoff(null)
    expect(r.attempt).toBe(1)
    expect(r.delayMs).toBe(1000)
  })

  it('doubles per attempt up to the 60s ceiling', () => {
    let state: BackoffState | null = null
    for (const expected of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000]) {
      state = nextBackoff(state)
      expect(state.delayMs).toBe(expected)
    }
  })

  it('stays clamped at 60s no matter how many attempts pile up', () => {
    let state: BackoffState | null = null
    for (let i = 0; i < 20; i++) state = nextBackoff(state)
    expect(state?.delayMs).toBe(60_000)
    expect(state?.attempt).toBe(20)
  })

  it('honours a positive Retry-After for that attempt', () => {
    const r = nextBackoff(null, 30_000)
    expect(r.delayMs).toBe(30_000)
    expect(r.attempt).toBe(1)
  })

  it('keeps climbing the curve after a Retry-After attempt', () => {
    const r1 = nextBackoff(null, 30_000)
    const r2 = nextBackoff(r1)
    expect(r2.attempt).toBe(2)
    expect(r2.delayMs).toBe(2000)
  })

  it('ignores a zero or negative Retry-After and uses the curve', () => {
    expect(nextBackoff(null, 0).delayMs).toBe(1000)
    expect(nextBackoff(null, -5).delayMs).toBe(1000)
  })
})

describe('nextBackoff jitter', () => {
  it('keeps every sampled first delay inside the floor and the +20% band', () => {
    const max = BACKOFF_DEFAULTS.baseDelayMs * (1 + BACKOFF_DEFAULTS.jitter)
    for (let i = 0; i < 200; i++) {
      const r = nextBackoff(null)
      expect(r.delayMs).toBeGreaterThanOrEqual(BACKOFF_DEFAULTS.minDelayMs)
      expect(r.delayMs).toBeLessThanOrEqual(Math.round(max))
    }
  })

  it('produces different delays across attempts at the same rung (the anti-herd property)', () => {
    const delays = new Set<number>()
    for (let i = 0; i < 50; i++) {
      delays.add(nextBackoff({ attempt: 5, delayMs: 0 }).delayMs)
    }
    // 16s base with plus or minus 20% is a 6.4s spread; 50 draws collapsing to
    // one value would mean the jitter is not being applied at all.
    expect(delays.size).toBeGreaterThan(1)
  })

  it('never returns less than the floor even when jitter is fully negative', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      expect(nextBackoff(null).delayMs).toBe(800)
      expect(nextBackoff({ attempt: 0, delayMs: 0 }).delayMs).toBeGreaterThanOrEqual(
        BACKOFF_DEFAULTS.minDelayMs,
      )
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('resetBackoff', () => {
  it('returns null so the next nextBackoff() restarts from attempt 1', () => {
    expect(resetBackoff()).toBeNull()
    expect(nextBackoff(resetBackoff()).attempt).toBe(1)
  })
})

describe('parseRetryAfter', () => {
  it('parses a positive integer second-count', () => {
    expect(parseRetryAfter('5')).toBe(5000)
    expect(parseRetryAfter('30')).toBe(30_000)
  })

  it('parses a fractional value, rounded to whole milliseconds', () => {
    expect(parseRetryAfter('1.5')).toBe(1500)
    expect(parseRetryAfter('0.0004')).toBe(0)
  })

  it('returns null for null, empty, and whitespace input', () => {
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter('   ')).toBeNull()
  })

  it('returns null for the HTTP-date form, which is deliberately unsupported', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull()
    expect(parseRetryAfter('abc')).toBeNull()
  })

  it('returns null for negative values', () => {
    expect(parseRetryAfter('-1')).toBeNull()
  })
})

describe('jitteredInterval', () => {
  it('spreads a fixed interval by plus or minus the given fraction', () => {
    for (let i = 0; i < 200; i++) {
      const value = jitteredInterval(60_000, 0.1)
      expect(value).toBeGreaterThanOrEqual(54_000)
      expect(value).toBeLessThanOrEqual(66_000)
    }
  })

  it('defaults to a 10% spread', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1)
    try {
      expect(jitteredInterval(60_000)).toBe(66_000)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('returns 0 for a non-positive or non-finite interval instead of NaN', () => {
    expect(jitteredInterval(0)).toBe(0)
    expect(jitteredInterval(-1)).toBe(0)
    expect(jitteredInterval(Number.NaN)).toBe(0)
  })

  it('never returns 0 for a positive interval, so a loop cannot spin', () => {
    expect(jitteredInterval(1, 0.9)).toBeGreaterThanOrEqual(1)
  })
})
