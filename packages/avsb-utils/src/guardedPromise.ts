// GuardedThenable — a promise-like whose `.catch()` is optional. Returned by
// `waitForFlag()` and similar wait surfaces. Adapted from
// `snippet/src/utils/guardedPromise.ts`.
//
// - every thenable handed out attaches its own internal `.catch(noop)`, so a
//   rejection never surfaces as an unhandledrejection no matter where the
//   author stops chaining
// - a shared `handled` flag flips true when the author passes a rejection
//   handler anywhere in the chain (`.catch(fn)` or `.then(_, fn)`)
// - on rejection with no author handler, the root logs once (deferred a
//   microtask so a handler attached later in the same synchronous tick still
//   wins) instead of throwing
// - `stop()` cancels the engine and leaves the promise pending forever

import type { Logger } from '@avsbhq/core'

export interface GuardedThenable<T> {
  then<TResult1 = T, TResult2 = never>(
    onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): GuardedThenable<TResult1 | TResult2>
  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): GuardedThenable<T | TResult>
  finally(onFinally?: (() => void) | null): GuardedThenable<T>
  /** Cancel the wait engine. Leaves the promise pending forever: no fire, no log. */
  stop(): void
}

export interface GuardedController<T> {
  thenable: GuardedThenable<T>
  resolve: (value: T) => void
  /** Logs gracefully via the logger iff the author never attached a handler. */
  reject: (reason: unknown) => void
  /** Engine registers its teardown here; run by thenable.stop(). */
  onStop: (fn: () => void) => void
}

export function createGuarded<T>(
  log: Logger,
  describe: () => string
): GuardedController<T> {
  let resolveFn!: (value: T) => void
  let rejectFn!: (reason: unknown) => void
  const inner = new Promise<T>((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })

  let settled = false
  let stopped = false
  let stopEngine: (() => void) | null = null
  const state = { handled: false }

  // Root logging guard: swallow the rejection and, a microtask later (after the
  // author's synchronous chain is fully built), warn iff nobody handled it.
  inner.catch((reason) => {
    queueMicrotask(() => {
      if (stopped || state.handled) return
      log.warn(`waitForFlag failed (${describe()})`, {
        reason: String(reason),
      })
    })
  })

  function doStop(): void {
    if (stopped || settled) return
    stopped = true
    if (stopEngine) stopEngine()
  }

  function wrap<U>(promise: Promise<U>): GuardedThenable<U> {
    promise.catch(() => undefined)
    return {
      then(onFulfilled, onRejected) {
        if (onRejected) state.handled = true
        return wrap(promise.then(onFulfilled, onRejected))
      },
      catch(onRejected) {
        if (onRejected) state.handled = true
        return wrap(promise.catch(onRejected))
      },
      finally(onFinally) {
        return wrap(promise.finally(onFinally ?? undefined))
      },
      stop: doStop,
    }
  }

  return {
    thenable: wrap(inner),
    resolve: (value: T) => {
      if (settled || stopped) return
      settled = true
      resolveFn(value)
    },
    reject: (reason: unknown) => {
      if (settled || stopped) return
      settled = true
      rejectFn(reason)
    },
    onStop: (fn: () => void) => {
      stopEngine = fn
    },
  }
}
