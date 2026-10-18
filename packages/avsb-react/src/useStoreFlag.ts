// =====================================================================
// The one store binding every rendering hook uses.
//
// THE TWO BUGS THIS FILE EXISTS TO KILL (report 03 §5 cluster A):
//
//   1. Exposure inflation from render. `useBoolFlag` and its three
//      siblings called `client.getBoolFlag(key, default)` inside
//      `getSnapshot`, with no options. That is a full evaluation: it fires
//      an exposure event and emits an `evaluation` event EVERY RENDER, so
//      experiment exposure counts became a function of how often React
//      chose to render. Silent data corruption. Every read here now passes
//      `{ readOnly: true }`, which the browser client documents as
//      "render-safe, cached, no side effects".
//
//   2. Re-subscribing on every render. Both callbacks were inline arrows,
//      so `subscribe` had a new identity on each render and React tore
//      down and re-created the subscription each time. Both are
//      `useCallback`-stable now.
//
// The three readers React needs, and where each answer comes from:
//
//   subscribe          client.subscribe(flagKey, ...) — per flag, and it
//                      also fires once on the ready transition.
//   getSnapshot        the client's cached read-only value. Identical
//                      object until that flag actually changes, which is
//                      what `useSyncExternalStore` requires.
//   getServerSnapshot  the value the SERVER evaluated, when the provider
//                      was given `serverFlags`. This is what makes
//                      server-rendered HTML show real values, and it is
//                      also what React reads during hydration, so the two
//                      agree by construction. Without it, a sentinel
//                      carrying the caller's default.
// =====================================================================

import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { notFoundFlag, notReadyFlag } from '@avsbhq/core'
import type { GetFlagOptions } from '@avsbhq/browser'
import { useAvsbContext } from './context'
import type { ReactAvsbClient } from './clientInterface'
import { readServerFlag } from './serverFlags'

/**
 * Hoisted so every read-only call passes the same object. The browser
 * client keys its snapshot cache on (flagKey, getter, default), not on
 * this object, but there is no reason to allocate one per render.
 */
export const READ_ONLY: GetFlagOptions = Object.freeze({ readOnly: true })

/** How one hook reads its flag. Module-level, so its identity is stable. */
export type FlagReader<T> = (
  client: ReactAvsbClient,
  flagKey: AvsbFlagKey,
  defaultValue: T,
) => Flag<T>

/** Generic read: no runtime type check, whatever the datafile says. */
export const readSnapshot = <T>(
  client: ReactAvsbClient,
  flagKey: AvsbFlagKey,
  defaultValue: T,
): Flag<T> => client.getSnapshot<T>(flagKey, defaultValue)

/** JSON key for a default value, or '' when it cannot be serialised. */
function defaultKeyOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return ''
  }
}

function sameDefault<T>(
  previous: { raw: T; key: string },
  raw: T,
  key: string,
): boolean {
  if (Object.is(previous.raw, raw)) return true
  // An unserialisable default ('' key) can only be compared by identity.
  return key !== '' && previous.key === key
}

/**
 * A `not_ready` sentinel that keeps the same identity while the caller
 * keeps passing the same default. Identity matters: React compares store
 * snapshots with `Object.is`, and a fresh sentinel per call is the
 * "getSnapshot should be cached to avoid an infinite loop" crash.
 *
 * `not_ready` rather than `not_found` on purpose (spec §1.2 / B15): "the
 * SDK has no datafile yet, ask again" and "that key is not in the
 * datafile" are different problems with different fixes.
 */
function useSentinel<T>(
  defaultValue: T,
  source: 'not_ready' | 'not_found',
  reason: string,
): Flag<T> {
  const ref = useRef<{ raw: T; key: string; reason: string; flag: Flag<T> } | null>(null)
  const key = defaultKeyOf(defaultValue)
  if (!ref.current || !sameDefault(ref.current, defaultValue, key) || ref.current.reason !== reason) {
    const flag =
      source === 'not_ready'
        ? notReadyFlag<T>(defaultValue, reason)
        : notFoundFlag<T>(defaultValue, reason)
    ref.current = { raw: defaultValue, key, reason, flag }
  }
  return ref.current.flag
}

/**
 * Bind one flag to React's external-store protocol.
 *
 * Every rendering hook in this package is a one-line call into here with a
 * different reader, so there is exactly one place where the store contract
 * is spoken.
 */
export function useFlagStore<T>(
  flagKey: AvsbFlagKey,
  defaultValue: T,
  read: FlagReader<T>,
): Flag<T> {
  const { client, serverFlags } = useAvsbContext()

  const sentinel = useSentinel<T>(
    defaultValue,
    'not_ready',
    'the SDK has no datafile yet, so this read returned your default value',
  )

  // N1-16: `serverFlags` holds every flag the server's datafile carried, so
  // a key it lacks is not in that datafile. Answer `not_found`, which is what
  // the client says once it loads; this used to render `not_ready` on the
  // server and flip to `not_found` after hydration.
  const missingOnServer = useSentinel<T>(
    defaultValue,
    'not_found',
    `flag "${flagKey}" not found in the datafile the server evaluated`,
  )

  const serverSnapshot = useMemo(() => {
    const evaluated = readServerFlag<T>(serverFlags, flagKey)
    if (evaluated) return evaluated
    return serverFlags ? missingOnServer : null
  }, [serverFlags, flagKey, missingOnServer])

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!client) return () => undefined
      return client.subscribe(flagKey, onStoreChange)
    },
    [client, flagKey],
  )

  const getSnapshot = useCallback(() => {
    // The server's value holds until the client can actually answer.
    //
    // Two situations, one rule. There may be no client yet (a server render, or
    // the first client render before the provider's layout effect builds one),
    // or there may be a client that has not loaded a datafile. Both used to
    // differ: with a client present this read went straight to it and got the
    // `not_ready` sentinel, so a server-rendered `true` flipped to the caller's
    // default the moment hydration handed over, then flipped back when the
    // datafile landed. That two-step flicker is the exact defect `serverFlags`
    // exists to remove, and `useFlagSuspense` documents the opposite ("the
    // server's value renders immediately, on the server and through hydration").
    //
    // Once the client IS readable it wins: it holds the live datafile, and its
    // subscription fires on the ready transition, so the swap happens on its own.
    if (serverSnapshot && !client?.isReady()) return serverSnapshot
    if (!client) return sentinel
    return read(client, flagKey, defaultValue)
  }, [client, flagKey, defaultValue, read, sentinel, serverSnapshot])

  const getServerSnapshot = useCallback(
    () => serverSnapshot ?? sentinel,
    [serverSnapshot, sentinel],
  )

  return useSyncExternalStore<Flag<T>>(subscribe, getSnapshot, getServerSnapshot)
}
