import type { ComputedRef } from 'vue'
import type { Flag } from '@avsbhq/core'
import { useAvsbContext } from '../context'
import {
  RENDER_SAFE,
  bindFlagRef,
  type FlagKeyInput,
} from '../internal/bindFlagRef'

/**
 * Read a number flag, type-checked against the type the platform declared
 * for it. A mismatch logs one warning and returns your `defaultValue`.
 *
 * Render-safe: no exposure is recorded (see `useExposure`).
 */
export function useNumberFlag(
  flagKey: FlagKeyInput,
  defaultValue: number
): ComputedRef<Flag<number>> {
  const { client } = useAvsbContext()
  return bindFlagRef<number>(client, flagKey, (c, key) =>
    c.getNumberFlag(key, defaultValue, RENDER_SAFE)
  )
}
