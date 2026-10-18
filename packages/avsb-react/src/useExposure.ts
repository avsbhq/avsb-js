import { useEffect, useRef } from 'react'
import type { AvsbFlagKey } from '@avsbhq/core'
import { useAvsbContext } from './context'

/** Options for `useExposure`. */
export interface UseExposureOptions {
  /**
   * Hold the exposure back while this is false. Use it when the variation
   * is rendered but not actually shown yet (a collapsed panel, a modal
   * that has not opened). Default true.
   */
  enabled?: boolean
}

/**
 * Record that this visitor was shown the variation of `flagKey`.
 *
 * ```ts
 * function useExposure(flagKey: string, options?: UseExposureOptions): void
 * ```
 *
 * This is the other half of the exposure contract. Reading a flag never
 * fires an exposure, because React retries, discards, and replays renders,
 * and analytics written from one of those would be wrong. This hook fires
 * exactly one exposure per flag per mounted view, from an effect, where a
 * decision really has been shown to a person.
 *
 * ```tsx
 * function Checkout() {
 *   const flag = useBoolFlag('checkout-v2', false)
 *   useExposure('checkout-v2')
 *   return flag.isEnabled() ? <CheckoutV2 /> : <CheckoutV1 />
 * }
 * ```
 *
 * It is also how a server-evaluated variation gets counted: a React Server
 * Component can evaluate with `evaluateFlagServer` and pass the value down
 * as a prop, and the client component that renders it calls
 * `useExposure(flagKey)` so results see the visitor.
 *
 * Details worth knowing:
 *
 * - Nothing fires until flags are readable. If the SDK is still loading,
 *   the exposure fires as soon as it becomes ready, so an exposure is
 *   never recorded against a default value.
 * - One exposure per flag key per mount. Remounting the component (a real
 *   navigation, not a re-render) counts again, which is the intent: that
 *   is a new view.
 * - React StrictMode runs effects twice in development. The guard here is
 *   a ref, which survives the simulated remount, so development fires once
 *   as well.
 */
export function useExposure(flagKey: AvsbFlagKey, options?: UseExposureOptions): void {
  const { client, status } = useAvsbContext()
  const enabled = options?.enabled !== false

  // Flag keys already exposed by THIS mounted component. A ref, so
  // StrictMode's setup/cleanup/setup cannot double-count.
  const firedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!client || !enabled) return
    if (status !== 'ready') return
    if (firedRef.current.has(flagKey)) return
    firedRef.current.add(flagKey)

    // A normal (not read-only) read is what fires the exposure. The value
    // is deliberately discarded: the component already read it for render.
    client.getFlag(flagKey, undefined)
  }, [client, flagKey, enabled, status])
}
