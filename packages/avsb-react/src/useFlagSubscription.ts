import { useEffect, useRef } from 'react'
import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { useAvsbContext } from './context'

/**
 * §5.16: Non-rendering subscription to a specific flag.
 *
 * Calls `cb` whenever the value of `flagKey` changes. Does NOT cause
 * the component to re-render. The callback ref is kept stable so callers
 * do not need to memoize it.
 *
 * Use this for imperative side effects (analytics, A/B logging) on a
 * per-flag basis. For rendering, use `useFlag()`.
 */
export function useFlagSubscription(
  flagKey: AvsbFlagKey,
  cb: (flag: Flag) => void
): void {
  const { client } = useAvsbContext()

  // Keep the latest callback in a ref to avoid stale closures.
  const cbRef = useRef(cb)
  cbRef.current = cb

  useEffect(() => {
    if (!client || typeof client.subscribe !== 'function') return

    // subscribe fires the cb-wrapper on every change to flagKey.
    // We then snapshot and forward the full Flag<unknown> value.
    const unsubscribe = client.subscribe(flagKey, () => {
      if (typeof client.getSnapshot === 'function') {
        const flag = client.getSnapshot<unknown>(flagKey, undefined)
        cbRef.current(flag as Flag)
      }
    })

    return unsubscribe
  }, [client, flagKey])
}
