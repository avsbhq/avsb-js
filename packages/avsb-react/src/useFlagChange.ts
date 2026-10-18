import { useEffect, useRef } from 'react'
import type { ClientEventMap } from '@avsbhq/core'
import { useAvsbContext } from './context'

type FlagChangeData = Parameters<ClientEventMap['flagChange']>[0]

/**
 * §5.16: Calls `cb` whenever any flag changes.
 *
 * This is a side-effect-only hook; it does not cause re-renders.
 * The callback ref is kept stable so callers do not need to memoize it.
 *
 * Use this for analytics, logging, or imperative side effects on flag
 * changes. For rendering based on flag changes, use `useFlag()`.
 */
export function useFlagChange(cb: (data: FlagChangeData) => void): void {
  const { client } = useAvsbContext()

  // Keep the latest callback in a ref to avoid stale-closure bugs
  // without requiring callers to memoize.
  const cbRef = useRef(cb)
  cbRef.current = cb

  useEffect(() => {
    if (!client || typeof client.on !== 'function') return

    const unsubscribe = client.on('flagChange', (data) => {
      cbRef.current(data)
    })

    return unsubscribe
  }, [client])
}
