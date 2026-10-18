import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { READ_ONLY, useFlagStore } from './useStoreFlag'
import type { FlagReader } from './useStoreFlag'

const readString: FlagReader<string> = (client, flagKey, defaultValue) =>
  client.getStringFlag(flagKey, defaultValue, READ_ONLY)

/**
 * Read a string flag.
 *
 * ```ts
 * function useStringFlag(flagKey: string, defaultValue: string): Flag<string>
 * ```
 *
 * The platform's declared type is checked at runtime. On a mismatch this
 * never throws: one warning is logged and your `defaultValue` comes back
 * with `source: 'not_found'`.
 *
 * Reading fires no exposure event. Pair it with `useExposure(flagKey)`
 * where the variation is shown.
 */
export function useStringFlag(flagKey: AvsbFlagKey, defaultValue: string): Flag<string> {
  return useFlagStore<string>(flagKey, defaultValue, readString)
}
