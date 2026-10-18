import type { AvsbFlagKey } from '@avsbhq/core'
import { useFlag } from './useFlag'

/**
 * §5.16: Convenience shortcut that returns the flag's raw value `T`
 * instead of the full `Flag<T>` object.
 *
 * Use `useFlag()` when you need `variationKey`, `source`, `reasons`, or
 * other evaluation metadata. Use this hook when you only care about the
 * value itself.
 */
export function useFlagValue<T>(flagKey: AvsbFlagKey, defaultValue: T): T {
  return useFlag(flagKey, defaultValue).value
}
