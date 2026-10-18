import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { readSnapshot, useFlagStore } from './useStoreFlag'

/**
 * Read one flag and re-render when its value changes.
 *
 * ```ts
 * function useFlag<T>(flagKey: string, defaultValue: T): Flag<T>
 * ```
 *
 * `T` comes from your explicit type argument when you give one
 * (`useFlag<string | null>('banner-copy', null)`) and from the default
 * value when you do not (`useFlag('checkout-v2', false)` is
 * `Flag<boolean>`). No runtime type check runs here: whatever the datafile
 * says is returned, typed as `T`. Use `useBoolFlag` and friends when you
 * want the platform's declared type enforced.
 *
 * The component re-renders only when THIS flag's value changes, not on
 * every flag change anywhere.
 *
 * Reading fires no exposure event, because React retries, discards, and
 * replays renders and analytics written from one of those would be wrong.
 * Call `useExposure(flagKey)` in the component that actually shows the
 * variation to a person.
 *
 * Before the SDK has a datafile the returned flag carries your default
 * with `source: 'not_ready'`; during a server render it carries the value
 * the server evaluated when the provider was given `serverFlags`.
 */
export function useFlag<T>(flagKey: AvsbFlagKey, defaultValue: T): Flag<T> {
  return useFlagStore<T>(flagKey, defaultValue, readSnapshot)
}
