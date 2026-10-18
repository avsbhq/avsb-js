import type { ComputedRef } from 'vue'
import type { Flag } from '@avsbhq/core'
import { useAvsbContext } from '../context'
import {
  RENDER_SAFE,
  bindFlagRef,
  type FlagKeyInput,
} from '../internal/bindFlagRef'

/**
 * Read a JSON flag as `Flag<T>`.
 *
 * The runtime check is that the platform declared this flag as JSON; the
 * shape of `T` is not validated. Validate the payload yourself (zod, a type
 * guard) if it crosses a trust boundary.
 *
 * Render-safe: no exposure is recorded (see `useExposure`).
 */
export function useJsonFlag<T>(
  flagKey: FlagKeyInput,
  defaultValue: T
): ComputedRef<Flag<T>> {
  const { client } = useAvsbContext()
  return bindFlagRef<T>(client, flagKey, (c, key) =>
    c.getJsonFlag<T>(key, defaultValue, RENDER_SAFE)
  )
}
