import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { READ_ONLY, useFlagStore } from './useStoreFlag'
import type { FlagReader } from './useStoreFlag'

const readNumber: FlagReader<number> = (client, flagKey, defaultValue) =>
  client.getNumberFlag(flagKey, defaultValue, READ_ONLY)

/**
 * Read a number flag.
 *
 * ```ts
 * function useNumberFlag(flagKey: string, defaultValue: number): Flag<number>
 * ```
 *
 * The platform's declared type is checked at runtime. On a mismatch this
 * never throws: one warning is logged and your `defaultValue` comes back
 * with `source: 'not_found'`.
 *
 * Reading fires no exposure event. Pair it with `useExposure(flagKey)`
 * where the variation is shown.
 */
export function useNumberFlag(flagKey: AvsbFlagKey, defaultValue: number): Flag<number> {
  return useFlagStore<number>(flagKey, defaultValue, readNumber)
}
