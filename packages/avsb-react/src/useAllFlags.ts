import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { Flag } from '@avsbhq/core'
import type { GetAllFlagsOptions } from '@avsbhq/browser'
import { useAvsbContext } from './context'

// =====================================================================
// THE BUG THIS FILE EXISTS TO KILL (report 03 §5): the "stable cache ref"
// assigned and returned a fresh `getAllFlags()` object on every call. The
// comment described a comparison that did not exist, so React saw a new
// store value on every render: "The result of getSnapshot should be
// cached to avoid an infinite loop", then a maximum-update-depth crash.
//
// The compare-and-swap below is still required even though the client now
// caches its own bulk read, because the pre-ready answer is a fresh `{}`
// literal per call. Comparing before swapping means a not-ready client
// hands back the SAME empty map on every render.
//
// Server-evaluated values are deliberately NOT served here. `useAllFlags`
// answers "every flag in the datafile", and the provider's `serverFlags`
// prop carries only what the server chose to evaluate: a per-key hook can
// honestly say "the server evaluated this one", a bulk hook cannot claim
// "these are all of them".
// =====================================================================

/** Hoisted: one options object for every bulk read this hook performs. */
const BULK_READ: GetAllFlagsOptions = Object.freeze({ fireExposures: false })

const EMPTY: Record<string, Flag> = Object.freeze({})

/** Two maps are the same read when they hold the same keys and objects. */
function sameFlagMap(a: Record<string, Flag>, b: Record<string, Flag>): boolean {
  if (a === b) return true
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

/**
 * Every flag in the datafile, keyed by flag key.
 *
 * ```ts
 * function useAllFlags(): Record<string, Flag>
 * ```
 *
 * Subscribes to the global `flagChange` event, so ANY flag change
 * re-renders the component and re-reads every flag. That is the right
 * shape for a debug panel or an admin view; to read one flag in a
 * component, `useFlag` re-renders only when that flag moves.
 *
 * Exposures are never fired by this hook. Values are `Flag<unknown>`
 * (`Flag`'s default type argument), so narrow before use:
 *
 * ```ts
 * const flags: Record<string, Flag> = useAllFlags()
 * const value: unknown = flags['dark-mode']?.value
 * ```
 *
 * Before the SDK is ready, and during a server render, this returns an
 * empty object.
 */
export function useAllFlags(): Record<string, Flag> {
  const { client } = useAvsbContext()

  const cacheRef = useRef<Record<string, Flag>>(EMPTY)

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!client) return () => undefined
      // 'flagChange' fires once per flag when the first datafile lands, so
      // it covers the ready transition as well as later publishes.
      const offFlagChange = client.on('flagChange', onStoreChange)
      const offReady = client.on('ready', onStoreChange)
      return () => {
        offFlagChange()
        offReady()
      }
    },
    [client],
  )

  const getSnapshot = useCallback((): Record<string, Flag> => {
    // `isReady()` first: a bulk read before the datafile exists returns a
    // fresh `{}` AND logs a warning, and neither belongs in a render.
    if (!client || !client.isReady()) return cacheRef.current
    const next = client.getAllFlags(BULK_READ)
    if (sameFlagMap(cacheRef.current, next)) return cacheRef.current
    cacheRef.current = next
    return next
  }, [client])

  const getServerSnapshot = useCallback((): Record<string, Flag> => EMPTY, [])

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
