import { computed, type ComputedRef } from 'vue'
import { useFlag } from './useFlag'
import type { FlagKeyInput } from '../internal/bindFlagRef'

/**
 * The flag's value on its own, with no `Flag<T>` wrapper: one `.value` in
 * script, and none in a template.
 *
 * Use `useFlag` when you also want `variationKey`, `source`, or `reasons`.
 */
export function useFlagValue<T>(
  flagKey: FlagKeyInput,
  defaultValue: T
): ComputedRef<T> {
  const flag = useFlag<T>(flagKey, defaultValue)
  return computed(() => flag.value.value)
}
