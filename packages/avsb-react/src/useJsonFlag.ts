import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { READ_ONLY, useFlagStore } from './useStoreFlag'
import type { FlagReader } from './useStoreFlag'

const readJson = <T>(
  client: Parameters<FlagReader<T>>[0],
  flagKey: AvsbFlagKey,
  defaultValue: T,
): Flag<T> => client.getJsonFlag<T>(flagKey, defaultValue, READ_ONLY)

/**
 * Read a JSON flag, typed as your own shape.
 *
 * ```ts
 * function useJsonFlag<T>(flagKey: string, defaultValue: T): Flag<T>
 * ```
 *
 * The runtime check confirms only that the platform declared the flag as
 * JSON; the shape of `T` is not validated. Validate it yourself (zod, or a
 * type guard) if the payload crosses a trust boundary. On a type mismatch
 * this never throws: one warning is logged and your `defaultValue` comes
 * back with `source: 'not_found'`.
 *
 * Passing a fresh object literal as the default every render is fine. The
 * SDK keys its snapshot cache on the default's JSON form, so
 * `useJsonFlag('api-config', { timeout: 5000 })` still returns the same
 * object every render.
 *
 * Reading fires no exposure event. Pair it with `useExposure(flagKey)`
 * where the variation is shown.
 */
export function useJsonFlag<T>(flagKey: AvsbFlagKey, defaultValue: T): Flag<T> {
  return useFlagStore<T>(flagKey, defaultValue, readJson)
}
