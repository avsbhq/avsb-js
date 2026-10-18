import type { ComputedRef } from 'vue'
import type { Flag } from '@avsbhq/core'
import { useAvsbContext } from '../context'
import {
  bindFlagRef,
  type FlagKeyInput,
} from '../internal/bindFlagRef'

/**
 * Read one flag and re-render when it changes.
 *
 * Returns `ComputedRef<Flag<T>>`, so in `<script setup>` the value is
 * `flag.value.value`: the outer `.value` unwraps Vue's ref, the inner one is
 * the flag's value. Templates unwrap the ref for you, so there it is
 * `flag.value`. See the README section "Why .value.value".
 *
 * `flagKey` may be a string or a ref; a ref re-subscribes when it changes.
 *
 * The read is render-safe: the same frozen object comes back until the value
 * actually changes, and no exposure is recorded. Use `useExposure` where the
 * decision is really shown to the visitor.
 */
export function useFlag<T>(
  flagKey: FlagKeyInput,
  defaultValue: T
): ComputedRef<Flag<T>> {
  const { client } = useAvsbContext()
  return bindFlagRef<T>(client, flagKey, (c, key) =>
    c.getSnapshot<T>(key, defaultValue)
  )
}
