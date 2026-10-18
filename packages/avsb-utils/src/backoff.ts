// =====================================================================
// `@avsbhq/utils/backoff` — the ONE retry curve for the whole SDK family.
//
// Why a package of its own subpath: the same algorithm existed three times
// (packages/avsb-node/src/reconnectBackoff.ts, packages/avsb-browser/src/
// backoff.ts, and an inlined copy at the top of this package's streaming.ts),
// each with its own comment saying the others were verbatim copies. Three
// copies of a retry curve is three chances for a fleet-wide thundering herd
// to come back in one runtime after being fixed in another. This module is
// the single source; every JS runtime imports it, and the per-language ports
// mirror these exact numbers.
//
// The curve: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped), each with plus or minus
// 20% jitter so clients that started together drift apart on every retry
// instead of re-hitting a struggling worker in lockstep. A server-supplied
// `Retry-After` wins for the one attempt it arrived on, and the attempt
// counter still climbs so the next miss continues up the curve rather than
// resetting to 1s.
//
// Zero dependencies and no runtime globals beyond Math.random, so this is
// safe in a browser bundle, a Worker, and Node alike.
// =====================================================================

/** One step of the curve: which attempt this is, and how long to wait. */
export interface BackoffState {
  /** 1 for the first retry. Never resets except through `resetBackoff`. */
  attempt: number
  /** Milliseconds to wait before the attempt. */
  delayMs: number
}

/**
 * The numbers the per-language ports mirror. Exported so a conformance
 * fixture or a port test can assert against the source of truth instead of
 * re-typing literals.
 */
export const BACKOFF_DEFAULTS = Object.freeze({
  /** First delay, doubled on each subsequent attempt. */
  baseDelayMs: 1000,
  /** Ceiling for the doubling, before jitter. */
  maxDelayMs: 60_000,
  /** Floor after jitter, so a jittered first attempt never lands near zero. */
  minDelayMs: 500,
  /** Symmetric jitter as a proportion of the base delay. */
  jitter: 0.2,
})

/**
 * Next delay in the curve. Pass `null` for the first retry.
 *
 * @param prev          the previous state, or null to start the curve
 * @param retryAfterMs  a positive value from a `Retry-After` header wins for
 *                      this attempt only
 */
export function nextBackoff(
  prev: BackoffState | null,
  retryAfterMs?: number,
): BackoffState {
  const attempt = (prev?.attempt ?? 0) + 1

  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    return { attempt, delayMs: retryAfterMs }
  }

  const base = Math.min(
    BACKOFF_DEFAULTS.maxDelayMs,
    BACKOFF_DEFAULTS.baseDelayMs * 2 ** (attempt - 1),
  )
  // Symmetric jitter around the base. Math.random() is in [0, 1), so
  // (random * 2 - 1) is in [-1, 1).
  const jitter = base * BACKOFF_DEFAULTS.jitter * (Math.random() * 2 - 1)
  const delayMs = Math.max(
    BACKOFF_DEFAULTS.minDelayMs,
    Math.round(base + jitter),
  )
  return { attempt, delayMs }
}

/**
 * Reset marker for "the last attempt succeeded, start from the top next
 * time". Kept as a function rather than a bare `null` so call sites read as
 * intent: `backoff = resetBackoff()`.
 */
export function resetBackoff(): BackoffState | null {
  return null
}

/**
 * Parse an HTTP `Retry-After` value into milliseconds.
 *
 * Only the numeric (seconds) form is supported, which is what the A vs B
 * workers emit. Returns null for anything we cannot interpret (including the
 * HTTP-date form) so the caller falls back to the curve rather than waiting
 * for `NaN` milliseconds.
 */
export function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null
  const trimmed = headerValue.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 1000)
}

/**
 * Apply symmetric jitter to a FIXED interval (the datafile polling loop),
 * as opposed to the growing curve above.
 *
 * Without it, every tab and every process that loaded after a deploy polls
 * the CDN on the same tick forever. `fraction` is the plus/minus proportion,
 * so 0.1 spreads a 60s interval across 54s to 66s.
 */
export function jitteredInterval(baseMs: number, fraction = 0.1): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0
  const spread = baseMs * fraction * (Math.random() * 2 - 1)
  return Math.max(1, Math.round(baseMs + spread))
}
