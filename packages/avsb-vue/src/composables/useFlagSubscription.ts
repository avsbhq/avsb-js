import { onScopeDispose, watch } from 'vue'
import type { Flag } from '@avsbhq/core'
import { useAvsbContext } from '../context'
import { resolveFlagKey, type FlagKeyInput } from '../internal/bindFlagRef'

/**
 * Run a side effect when one flag changes, without re-rendering.
 *
 * The callback also runs once when the first datafile lands, so a component
 * mounted before the SDK was ready still hears about the real value. Use
 * `useFlag` when the value drives what you render; use this for analytics,
 * logging, or imperative work.
 *
 * The flag handed to the callback is a render-safe read: it records no
 * exposure.
 */
export function useFlagSubscription(
  flagKey: FlagKeyInput,
  callback: (flag: Flag) => void
): void {
  const { client } = useAvsbContext()

  let unsubscribe: (() => void) | undefined

  const subscribe = (key: string): void => {
    unsubscribe?.()
    unsubscribe = client.subscribe(key, () => {
      callback(client.getSnapshot<unknown>(key, undefined))
    })
  }

  subscribe(resolveFlagKey(flagKey))

  const stopWatcher =
    typeof flagKey === 'string'
      ? undefined
      : watch(flagKey, (next: string) => subscribe(next), { flush: 'sync' })

  onScopeDispose(() => {
    stopWatcher?.()
    unsubscribe?.()
    unsubscribe = undefined
  })
}
