import { createContext, useContext } from 'react'
import type { Flag } from '@avsbhq/core'
import type { ReactAvsbClient } from './clientInterface'
import type { AvsbStatus } from './providerStatus'

// -----------------------------------------------------------------------
// Internal context value. Not part of the public surface: hooks are the
// public surface, and everything here is reachable through one of them.
// -----------------------------------------------------------------------

export interface AvsbContextValue {
  /** null on the very first render of Mode A, and during SSR. */
  client: ReactAvsbClient | null
  status: AvsbStatus
  /** Set for a fatal init failure, and for a degraded (stale) ready state. */
  error?: Error
  /** Ready, but serving values that may be stale after a failed refresh. */
  degraded?: boolean
  /**
   * Server-evaluated values, revived into real `Flag` objects once per
   * mount. Feeds every hook's `getServerSnapshot` so server HTML and the
   * hydration render agree.
   */
  serverFlags?: Record<string, Flag> | null
  /**
   * Resolves when `status` leaves `'loading'`. Suspense hooks throw this
   * instead of `client.onReady()`, for two reasons: it exists before the
   * client does (Mode A creates the client in an effect), and it is tied
   * to the state React will actually re-render with, so an
   * already-resolved promise cannot be thrown in a loop.
   */
  whenReady?: Promise<void>
}

// -----------------------------------------------------------------------
// Sentinel so "hook called outside the provider" is a clear error rather
// than a confusing null.
// -----------------------------------------------------------------------

const NOT_IN_PROVIDER: unique symbol = Symbol('avsb-not-in-provider')

export const AvsbContext = createContext<AvsbContextValue | typeof NOT_IN_PROVIDER>(
  NOT_IN_PROVIDER,
)

/**
 * Internal hook consumed by every public hook.
 * Throws if called outside `<AvsbProvider>`.
 */
export function useAvsbContext(): AvsbContextValue {
  const value = useContext(AvsbContext)
  if (value === NOT_IN_PROVIDER) {
    throw new Error(
      '[avsb] hooks must be used inside <AvsbProvider>. ' +
        'Wrap your component tree with <AvsbProvider sdkKey="..." context={...}>.',
    )
  }
  return value
}
