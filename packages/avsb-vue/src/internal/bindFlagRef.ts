import {
  computed,
  isRef,
  onScopeDispose,
  shallowRef,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue'
import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import type { VueAvsbClient } from '../clientInterface'

/** A flag key, or a ref holding one. */
export type FlagKeyInput = AvsbFlagKey | Ref<AvsbFlagKey> | ComputedRef<AvsbFlagKey>

/** How one composable reads its flag. Always a render-safe read. */
export type FlagReader<T> = (client: VueAvsbClient, flagKey: string) => Flag<T>

/**
 * Options every render-path read passes.
 *
 * `readOnly` is the whole point: it returns the same frozen object until the
 * value changes (what a computed needs to stay stable) and fires NO exposure,
 * because a render is a read, not a decision. Without it, exposure counts
 * become a function of how often Vue re-renders and experiment results are
 * quietly wrong.
 */
export const RENDER_SAFE = { readOnly: true } as const

export function resolveFlagKey(flagKey: FlagKeyInput): string {
  return isRef(flagKey) ? flagKey.value : flagKey
}

/**
 * Subscribe to one flag and expose it as a `ComputedRef<Flag<T>>`.
 *
 * Behaviour that matters:
 * - The first value is read synchronously at call time, so a bootstrapped or
 *   cached client renders real values on the first pass (no default flash).
 * - The subscription is registered immediately, not in `onMounted`, so a
 *   datafile that lands between setup and mount is not missed.
 * - A reactive key re-subscribes synchronously when it changes.
 * - Cleanup runs on scope disposal, which covers component unmount and any
 *   `effectScope()` a caller composes this into.
 */
export function bindFlagRef<T>(
  client: VueAvsbClient,
  flagKey: FlagKeyInput,
  read: FlagReader<T>
): ComputedRef<Flag<T>> {
  const current = shallowRef<Flag<T>>(read(client, resolveFlagKey(flagKey)))

  let unsubscribe: (() => void) | undefined

  const subscribe = (key: string): void => {
    unsubscribe?.()
    current.value = read(client, key)
    unsubscribe = client.subscribe(key, () => {
      current.value = read(client, key)
    })
  }

  subscribe(resolveFlagKey(flagKey))

  const stopWatcher = isRef(flagKey)
    ? watch(flagKey, (next: string) => subscribe(next), { flush: 'sync' })
    : undefined

  onScopeDispose(() => {
    stopWatcher?.()
    unsubscribe?.()
    unsubscribe = undefined
  })

  return computed(() => current.value)
}
