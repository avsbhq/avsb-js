import { Observable } from 'rxjs'
import type { Flag } from '@avsbhq/core'
import type { AngularAvsbClient } from '../clientInterface'

/**
 * A render-safe read of one flag: the same object until that flag's value
 * changes, no exposure event, no `evaluation` event. Either
 * `client.getSnapshot` or a typed getter called with `{ readOnly: true }`.
 */
export type SnapshotRead<T> = (
  client: AngularAvsbClient,
  flagKey: string,
  defaultValue: T
) => Flag<T>

/**
 * One flag as an Observable, built on the store contract frozen in
 * `@avsbhq/browser` (subscribe + read-only read).
 *
 * Two properties the rest of this package relies on:
 *
 * 1. **It emits synchronously on subscribe.** The first value is available
 *    before `subscribe()` returns, which is what lets `toSignal(...,
 *    { requireSync: true })` produce `Signal<Flag<T>>` instead of
 *    `Signal<Flag<T> | undefined>`, and what lets the pipe answer on its
 *    first `transform()` call without inventing a "no value yet" state.
 * 2. **It re-emits on the ready transition**, because `client.subscribe`
 *    notifies every subscriber once the first datafile is applied, even for
 *    keys the datafile does not contain.
 *
 * The observable never completes and never errors: a flag read has no
 * failure mode, only a `Flag.source` explaining where the value came from.
 */
export function flagStream<T>(
  client: AngularAvsbClient,
  flagKey: string,
  defaultValue: T,
  read: SnapshotRead<T>
): Observable<Flag<T>> {
  return new Observable<Flag<T>>((subscriber) => {
    subscriber.next(read(client, flagKey, defaultValue))

    const unsubscribe = client.subscribe(flagKey, () => {
      if (subscriber.closed) return
      subscriber.next(read(client, flagKey, defaultValue))
    })

    return () => {
      unsubscribe()
    }
  })
}

/** Read one flag with no type check. Generic reads accept whatever is there. */
export function readSnapshot<T>(
  client: AngularAvsbClient,
  flagKey: string,
  defaultValue: T
): Flag<T> {
  return client.getSnapshot<T>(flagKey, defaultValue)
}

/**
 * The four typed reads, each keeping the runtime type check the platform
 * declared for the flag. A mismatch does not throw: the client logs one
 * warning naming the flag and the getter, then answers with the default
 * value and `source: 'not_found'`.
 */
export const readBool: SnapshotRead<boolean> = (client, flagKey, defaultValue) =>
  client.getBoolFlag(flagKey, defaultValue, { readOnly: true })

export const readString: SnapshotRead<string> = (client, flagKey, defaultValue) =>
  client.getStringFlag(flagKey, defaultValue, { readOnly: true })

export const readNumber: SnapshotRead<number> = (client, flagKey, defaultValue) =>
  client.getNumberFlag(flagKey, defaultValue, { readOnly: true })

export function readJson<T>(
  client: AngularAvsbClient,
  flagKey: string,
  defaultValue: T
): Flag<T> {
  return client.getJsonFlag<T>(flagKey, defaultValue, { readOnly: true })
}
