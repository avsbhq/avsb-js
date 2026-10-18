// FallbackChain + circuitBreaker. Spec §6.2.
//
// FallbackChain expresses layered fallback semantics:
//   default → local override → cached remote → live
// Each layer is tried in order; the first one to resolve a non-null value
// wins. The chain short-circuits and remembers which layer produced the
// value so callers can attribute the source.
//
// circuitBreaker wraps an async function with rolling failure-rate
// accounting. Opens on threshold consecutive failures, half-opens after a
// reset window, fully closes on the first half-open success.

export interface FallbackLayer<T> {
  name: string
  resolve(): Promise<T | null | undefined> | T | null | undefined
}

export interface FallbackResult<T> {
  value: T
  source: string
}

export class FallbackChain<T> {
  private readonly layers: FallbackLayer<T>[]

  constructor(layers: FallbackLayer<T>[] = []) {
    this.layers = [...layers]
  }

  add(layer: FallbackLayer<T>): this {
    this.layers.push(layer)
    return this
  }

  async run(): Promise<FallbackResult<T> | null> {
    for (const layer of this.layers) {
      try {
        const v = await layer.resolve()
        if (v !== null && v !== undefined) {
          return { value: v, source: layer.name }
        }
      } catch {
        // each layer is best-effort; continue to next
      }
    }
    return null
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening. Default 5. */
  threshold?: number
  /** ms before transitioning to half-open. Default 30000. */
  resetTimeoutMs?: number
  /** Fallback value or function when open. */
  fallback?: <A extends unknown[], R>(...args: A) => R
}

type CircuitState = 'closed' | 'open' | 'half-open'

export function circuitBreaker<
  F extends (...a: never[]) => Promise<unknown>,
>(fn: F, opts: CircuitBreakerOptions = {}): F {
  const threshold = opts.threshold ?? 5
  const resetTimeoutMs = opts.resetTimeoutMs ?? 30_000
  let state: CircuitState = 'closed'
  let consecutiveFailures = 0
  let openedAt = 0

  const wrapped = async (...args: unknown[]): Promise<unknown> => {
    if (state === 'open') {
      if (Date.now() - openedAt >= resetTimeoutMs) {
        state = 'half-open'
      } else {
        if (opts.fallback) {
          return (opts.fallback as (...a: unknown[]) => unknown)(...args)
        }
        throw new Error('Circuit breaker is open')
      }
    }
    try {
      const result = await (fn as unknown as (
        ...a: unknown[]
      ) => Promise<unknown>)(...args)
      consecutiveFailures = 0
      state = 'closed'
      return result
    } catch (err) {
      consecutiveFailures++
      if (consecutiveFailures >= threshold) {
        state = 'open'
        openedAt = Date.now()
      }
      throw err
    }
  }

  return wrapped as unknown as F
}
