// Timing helpers — once/debounce/throttle/retry/sleep/withTimeout/withDeadline.
// Spec §6.2. All wrappers register a cancel handle with the cleanup registry
// so `client.close()` drains pending timers.

import type { CleanupRegistry } from './registry'

type AnyFn = (...args: never[]) => unknown
type AnyVoidFn = (...args: never[]) => void

export interface CancelHandle {
  cancel(): void
}

export interface RetryOptions {
  /** Default 3. */
  attempts?: number
  /** Initial backoff in ms. Default 200. */
  delay?: number
  /** Exponential factor. Default 2. */
  factor?: number
  /** ±jitter fraction (0..1). Default 0 (deterministic). */
  jitter?: number
  /**
   * Circuit-breaker hint: after this many consecutive failures, give up
   * immediately. Defaults to `attempts` (i.e. disabled; fail naturally).
   */
  circuitBreakerThreshold?: number
}

export function once<F extends AnyFn>(fn: F): F {
  let called = false
  let result: unknown
  const wrapped = (...args: unknown[]): unknown => {
    if (!called) {
      called = true
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wrapper must spread author args
      result = (fn as (...a: any[]) => unknown)(...args)
    }
    return result
  }
  return wrapped as unknown as F
}

export function debounce<F extends AnyVoidFn>(
  fn: F,
  ms: number,
  registry?: CleanupRegistry
): F & CancelHandle {
  let timerId: ReturnType<typeof setTimeout> | null = null

  function cancel(): void {
    if (timerId !== null) {
      clearTimeout(timerId)
      timerId = null
    }
  }

  const wrapped = (...args: unknown[]): void => {
    cancel()
    timerId = setTimeout(() => {
      timerId = null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wrapper must spread author args
      ;(fn as unknown as (...a: any[]) => void)(...args)
    }, ms)
  }

  ;(wrapped as unknown as { cancel: () => void }).cancel = cancel
  registry?.add(cancel)
  return wrapped as unknown as F & CancelHandle
}

export function throttle<F extends AnyVoidFn>(
  fn: F,
  ms: number,
  registry?: CleanupRegistry
): F & CancelHandle {
  let lastCall = 0
  let trailingId: ReturnType<typeof setTimeout> | null = null
  let lastArgs: unknown[] = []

  function cancel(): void {
    if (trailingId !== null) {
      clearTimeout(trailingId)
      trailingId = null
    }
  }

  const wrapped = (...args: unknown[]): void => {
    const now = Date.now()
    const elapsed = now - lastCall
    lastArgs = args
    if (elapsed >= ms) {
      lastCall = now
      if (trailingId !== null) {
        clearTimeout(trailingId)
        trailingId = null
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wrapper must spread author args
      ;(fn as unknown as (...a: any[]) => void)(...args)
    } else {
      if (trailingId !== null) clearTimeout(trailingId)
      trailingId = setTimeout(() => {
        trailingId = null
        lastCall = Date.now()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wrapper must spread author args
        ;(fn as unknown as (...a: any[]) => void)(...lastArgs)
      }, ms - elapsed)
    }
  }

  ;(wrapped as unknown as { cancel: () => void }).cancel = cancel
  registry?.add(cancel)
  return wrapped as unknown as F & CancelHandle
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms))
}

export async function retry<T>(
  fn: () => Promise<T> | T,
  opts?: RetryOptions
): Promise<T> {
  const attempts = opts?.attempts ?? 3
  const delay = opts?.delay ?? 200
  const factor = opts?.factor ?? 2
  const jitter = opts?.jitter ?? 0
  const threshold = opts?.circuitBreakerThreshold ?? attempts

  let lastError: unknown
  let consecutiveFailures = 0

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (consecutiveFailures >= threshold) {
      throw lastError ?? new Error('circuit breaker open')
    }
    try {
      return await fn()
    } catch (err) {
      lastError = err
      consecutiveFailures++
      if (attempt < attempts - 1) {
        const base = delay * Math.pow(factor, attempt)
        const jitterAmount =
          jitter > 0 ? base * jitter * (Math.random() * 2 - 1) : 0
        await sleep(Math.max(0, base + jitterAmount))
      }
    }
  }
  throw lastError
}

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${ms}ms`))
    }, ms)
  })
  try {
    return await Promise.race([promise, timeoutP])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

export async function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number
): Promise<T> {
  const remaining = deadlineMs - Date.now()
  if (remaining <= 0) {
    throw new Error('Deadline already passed')
  }
  return withTimeout(promise, remaining)
}
