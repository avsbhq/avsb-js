import type { ComputedRef } from 'vue'
import type { Flag } from '@avsbhq/core'
import { useAvsbContext } from '../context'
import {
  RENDER_SAFE,
  bindFlagRef,
  type FlagKeyInput,
} from '../internal/bindFlagRef'

/**
 * Read a string flag, type-checked against the type the platform declared
 * for it. A mismatch logs one warning and returns your `defaultValue`.
 *
 * Render-safe: no exposure is recorded (see `useExposure`).
 */
export function useStringFlag(
  flagKey: FlagKeyInput,
  defaultValue: string
): ComputedRef<Flag<string>> {
  const { client } = useAvsbContext()
  return bindFlagRef<string>(client, flagKey, (c, key) =>
    c.getStringFlag(key, defaultValue, RENDER_SAFE)
  )
}
