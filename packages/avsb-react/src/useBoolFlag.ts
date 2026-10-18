import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { READ_ONLY, useFlagStore } from './useStoreFlag'
import type { FlagReader } from './useStoreFlag'

const readBool: FlagReader<boolean> = (client, flagKey, defaultValue) =>
  client.getBoolFlag(flagKey, defaultValue, READ_ONLY)

/**
 * Read a boolean flag.
 *
 * ```ts
 * function useBoolFlag(flagKey: string, defaultValue: boolean): Flag<boolean>
 * ```
 *
 * The platform's declared type for the flag is checked at runtime. On a
 * mismatch this never throws: the SDK logs one warning naming the flag,
 * the getter, and the declared type, then returns your `defaultValue` with
 * `source: 'not_found'`.
 *
 * Reading fires no exposure event. Pair it with `useExposure(flagKey)`
 * where the variation is shown.
 */
export function useBoolFlag(flagKey: AvsbFlagKey, defaultValue: boolean): Flag<boolean> {
  return useFlagStore<boolean>(flagKey, defaultValue, readBool)
}
