import type { ComputedRef } from 'vue'
import type { Flag } from '@avsbhq/core'
import { useAvsbContext } from '../context'
import {
  RENDER_SAFE,
  bindFlagRef,
  type FlagKeyInput,
} from '../internal/bindFlagRef'

/**
 * Read a boolean flag, type-checked against the type the platform declared
 * for it.
 *
 * On a mismatch nothing throws: the SDK logs one warning naming the flag and
 * the getter, and you get your `defaultValue` back with
 * `source: 'not_found'`.
 *
 * Render-safe: no exposure is recorded (see `useExposure`).
 */
export function useBoolFlag(
  flagKey: FlagKeyInput,
  defaultValue: boolean
): ComputedRef<Flag<boolean>> {
  const { client } = useAvsbContext()
  return bindFlagRef<boolean>(client, flagKey, (c, key) =>
    c.getBoolFlag(key, defaultValue, RENDER_SAFE)
  )
}
