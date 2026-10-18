// =====================================================================
// Datafile polling loop (WS2 item 4, report 02 §5.31 and §7.21).
//
// What it replaces: a bare `setInterval(pollingInterval)` with no minimum
// and no jitter. `pollingInterval: 1` was accepted (one request per
// millisecond, from a customer's browser), every tab polled on the same
// tick forever, and a backgrounded tab kept polling for hours.
//
// What this does instead:
//
//   clamp       never faster than `minIntervalMs` (5s, matching node).
//   jitter      each tick is scheduled with plus or minus 10% spread, so
//               a fleet that loaded together drifts apart instead of
//               hammering the CDN in lockstep.
//   pause       a hidden tab stops polling. On becoming visible again it
//               polls immediately when at least one interval elapsed while
//               hidden, which is also what makes a restored tab correct
//               rather than merely quiet.
//   focus       refetch on window focus, throttled to `minIntervalMs`, so
//               returning to a tab shows current flags.
//
// A setTimeout chain is used rather than setInterval: each tick has to
// carry its own jitter, and an overlapping tick has to be impossible while
// a fetch is still in flight.
// =====================================================================

import type { Logger } from '@avsbhq/core'
import { jitteredInterval } from './backoff'

/** Matches node's clamp (AvsbServer.ts) so both runtimes floor identically. */
export const MIN_POLLING_INTERVAL_MS = 5000

export interface PollingLoopOptions {
  intervalMs: number
  minIntervalMs?: number
  /** Plus/minus proportion of jitter per tick. Default 0.1. */
  jitter?: number
  /** Stop polling while the tab is hidden. Default true. */
  pauseWhenHidden?: boolean
  /** Refetch when the window regains focus. Default true. */
  refetchOnFocus?: boolean
  /** Runs on every tick. Returns a promise; the next tick waits for it. */
  onTick: () => Promise<void> | void
  logger?: Logger
}

export interface PollingLoop {
  start(): void
  stop(): void
  /** True while a hidden tab has the loop suspended. */
  isPaused(): boolean
  /** The clamped base interval actually in use. */
  intervalMs(): number
}

function documentIsHidden(): boolean {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'hidden'
}

export function createPollingLoop(options: PollingLoopOptions): PollingLoop {
  const minIntervalMs = options.minIntervalMs ?? MIN_POLLING_INTERVAL_MS
  const requested = options.intervalMs
  const baseIntervalMs = Math.max(minIntervalMs, requested)
  const jitter = options.jitter ?? 0.1
  const pauseWhenHidden = options.pauseWhenHidden !== false
  const refetchOnFocus = options.refetchOnFocus !== false
  const logger = options.logger

  if (Number.isFinite(requested) && requested < minIntervalMs) {
    logger?.warn(
      `AvsB pollingInterval ${requested}ms is below the ${minIntervalMs}ms minimum, ` +
        `so ${baseIntervalMs}ms is being used instead. Datafile updates also arrive ` +
        'instantly with streaming: true, which is cheaper than fast polling.',
    )
  }

  let timerId: ReturnType<typeof setTimeout> | null = null
  let running = false
  let paused = false
  let ticking = false
  let lastTickAt = 0
  let dueWhileHidden = false
  let visibilityHandler: (() => void) | null = null
  let focusHandler: (() => void) | null = null

  function clearTimer(): void {
    if (timerId !== null) {
      clearTimeout(timerId)
      timerId = null
    }
  }

  function schedule(): void {
    clearTimer()
    if (!running || paused) return
    timerId = setTimeout(() => {
      timerId = null
      void runTick('interval')
    }, jitteredInterval(baseIntervalMs, jitter))
  }

  async function runTick(reason: 'interval' | 'visible' | 'focus'): Promise<void> {
    // A tick already in flight wins: overlapping datafile fetches would
    // race each other into the flag cache.
    if (!running || ticking) return
    ticking = true
    try {
      await options.onTick()
    } finally {
      ticking = false
      lastTickAt = Date.now()
      if (reason !== 'interval') logger?.debug('polled the datafile early', { reason })
      schedule()
    }
  }

  function onVisibilityChange(): void {
    if (!running) return
    if (documentIsHidden()) {
      paused = true
      clearTimer()
      // Remember whether a tick was owed, so becoming visible refetches
      // immediately rather than waiting out a full fresh interval.
      dueWhileHidden = Date.now() - lastTickAt >= baseIntervalMs
      return
    }

    paused = false
    if (dueWhileHidden || Date.now() - lastTickAt >= baseIntervalMs) {
      dueWhileHidden = false
      void runTick('visible')
      return
    }
    schedule()
  }

  function onFocus(): void {
    if (!running || paused) return
    if (Date.now() - lastTickAt < minIntervalMs) return
    void runTick('focus')
  }

  function start(): void {
    if (running) return
    running = true
    lastTickAt = Date.now()
    paused = pauseWhenHidden && documentIsHidden()

    if (pauseWhenHidden && typeof document !== 'undefined' && document.addEventListener) {
      visibilityHandler = onVisibilityChange
      document.addEventListener('visibilitychange', visibilityHandler)
    }
    if (refetchOnFocus && typeof window !== 'undefined' && window.addEventListener) {
      focusHandler = onFocus
      window.addEventListener('focus', focusHandler)
    }

    schedule()
  }

  function stop(): void {
    running = false
    paused = false
    clearTimer()
    if (visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandler)
      visibilityHandler = null
    }
    if (focusHandler && typeof window !== 'undefined') {
      window.removeEventListener('focus', focusHandler)
      focusHandler = null
    }
  }

  return {
    start,
    stop,
    isPaused: () => paused,
    intervalMs: () => baseIntervalMs,
  }
}
