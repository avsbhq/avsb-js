// Change streams. Spec §6.2.
//
// `changes()` is an async iterator over `flagChange` events. `onFlagChange`
// subscribes to a single key; `waitForFlag` returns a guarded thenable
// that resolves when the flag exists (or the predicate passes).
//
// All subscriptions register a teardown with the supplied registry so
// `client.close()` drains them.

import type { Flag, ClientEventMap, Logger } from '@avsbhq/core'
import type { CleanupRegistry } from './registry'
import { createGuarded } from './guardedPromise'
import type { GuardedThenable } from './guardedPromise'

/**
 * Client surface the change helpers consume. Both browser AvsbClient and
 * server AvsbServer (when called inside a `forUser` scope) expose `on()`
 * and `getFlag()` for arbitrary keys.
 */
export interface ChangeClient {
  on<E extends keyof ClientEventMap>(
    event: E,
    cb: ClientEventMap[E]
  ): () => void
  getFlag<T = unknown>(key: string, defaultValue: T): Flag<T>
}

export interface WaitForFlagOptions {
  /** ms to wait before rejecting. Default 30000. */
  timeout?: number
  /** Reject if the flag isn't found by deadline. Default true. */
  rejectOnTimeout?: boolean
}

export function createChanges(
  client: ChangeClient,
  registry: CleanupRegistry,
  log: Logger
): {
  changes(): AsyncIterableIterator<ClientEventMap['flagChange'] extends (data: infer D) => unknown ? D : never>
  onFlagChange(flagKey: string, cb: (flag: Flag) => void): () => void
  waitForFlag<T = unknown>(
    flagKey: string,
    predicate?: (flag: Flag<T>) => boolean,
    opts?: WaitForFlagOptions
  ): GuardedThenable<Flag<T>>
} {
  type ChangePayload = ClientEventMap['flagChange'] extends (data: infer D) => unknown
    ? D
    : never

  function changes(): AsyncIterableIterator<ChangePayload> {
    const queue: ChangePayload[] = []
    let pending: ((value: IteratorResult<ChangePayload>) => void) | null = null
    let finished = false

    const unsub = client.on('flagChange', (data) => {
      if (finished) return
      if (pending) {
        const resolve = pending
        pending = null
        resolve({ value: data, done: false })
      } else {
        queue.push(data)
      }
    })

    const teardown = registry.add(() => {
      finished = true
      unsub()
      if (pending) {
        const resolve = pending
        pending = null
        resolve({ value: undefined as unknown as ChangePayload, done: true })
      }
    })

    const iter: AsyncIterableIterator<ChangePayload> = {
      [Symbol.asyncIterator]() {
        return iter
      },
      next(): Promise<IteratorResult<ChangePayload>> {
        if (finished) {
          return Promise.resolve({
            value: undefined as unknown as ChangePayload,
            done: true,
          })
        }
        if (queue.length > 0) {
          const value = queue.shift()!
          return Promise.resolve({ value, done: false })
        }
        return new Promise((resolve) => {
          pending = resolve
        })
      },
      return(): Promise<IteratorResult<ChangePayload>> {
        teardown()
        return Promise.resolve({
          value: undefined as unknown as ChangePayload,
          done: true,
        })
      },
      throw(err: unknown): Promise<IteratorResult<ChangePayload>> {
        teardown()
        return Promise.reject(err)
      },
    }
    return iter
  }

  function onFlagChange(
    flagKey: string,
    cb: (flag: Flag) => void
  ): () => void {
    const unsub = client.on('flagChange', (data) => {
      if (data.flagKey !== flagKey) return
      try {
        cb(client.getFlag(flagKey, data.newValue))
      } catch (e) {
        log.warn('onFlagChange callback threw', { error: String(e) })
      }
    })
    const dispose = registry.add(unsub)
    return dispose
  }

  function waitForFlag<T = unknown>(
    flagKey: string,
    predicate?: (flag: Flag<T>) => boolean,
    opts?: WaitForFlagOptions
  ): GuardedThenable<Flag<T>> {
    const ctrl = createGuarded<Flag<T>>(log, () => `waitForFlag(${flagKey})`)
    const timeout = opts?.timeout ?? 30_000
    const rejectOnTimeout = opts?.rejectOnTimeout ?? true

    const check = (flag: Flag<T>): boolean => {
      if (!flag.exists()) return false
      return predicate ? predicate(flag) : true
    }

    // First, check immediately.
    const initial = client.getFlag<T>(flagKey, null as unknown as T)
    if (check(initial)) {
      ctrl.resolve(initial)
      return ctrl.thenable
    }

    const unsub = client.on('flagChange', (data) => {
      if (data.flagKey !== flagKey) return
      const f = client.getFlag<T>(flagKey, null as unknown as T)
      if (check(f)) ctrl.resolve(f)
    })

    const timer = setTimeout(() => {
      if (rejectOnTimeout) {
        ctrl.reject(
          new Error(`waitForFlag('${flagKey}') timed out after ${timeout}ms`)
        )
      }
      unsub()
    }, timeout)

    ctrl.onStop(() => {
      clearTimeout(timer)
      unsub()
    })
    registry.add(() => ctrl.thenable.stop())

    return ctrl.thenable
  }

  return { changes, onFlagChange, waitForFlag }
}
