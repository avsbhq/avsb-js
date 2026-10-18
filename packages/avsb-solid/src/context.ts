import { createContext, useContext, type Accessor } from 'solid-js'
import type { SolidAvsbClient } from './clientInterface'
import type { AvsbStatus } from './types'

// -----------------------------------------------------------------------
// The value <AvsbProvider> provides.
//
// `client` is NOT nullable: a provider either has a client or throws at
// creation with an actionable message, so no accessor has to carry a
// "there is no client" branch that silently serves defaults.
//
// `status`, `error`, and `degraded` are accessors, so reading them inside a
// memo or JSX tracks them the way any other signal does.
// -----------------------------------------------------------------------

export interface AvsbContextValue {
  client: SolidAvsbClient
  status: Accessor<AvsbStatus>
  /**
   * The last error the SDK reported. Present while `status()` is `'error'`,
   * and also present with `status() === 'ready'` when a refresh failed while
   * cached flags are still being served (`degraded()`).
   */
  error: Accessor<Error | undefined>
  /** Serving a stale bootstrap or cached datafile after a failed refresh. */
  degraded: Accessor<boolean>
}

const NOT_IN_PROVIDER: unique symbol = Symbol('avsb-not-in-provider')

export const AvsbContext = createContext<
  AvsbContextValue | typeof NOT_IN_PROVIDER
>(NOT_IN_PROVIDER)

/**
 * Read the provider context. Throws when called outside <AvsbProvider>,
 * naming the fix.
 *
 * Internal to the package: every public accessor calls it.
 */
export function useAvsbContext(): AvsbContextValue {
  const value = useContext(AvsbContext)
  if (value === NOT_IN_PROVIDER) {
    throw new Error(
      '[avsb] the flag accessors must be called inside <AvsbProvider>. Wrap ' +
        'your component tree with ' +
        '<AvsbProvider sdkKey="sdk_production_..." context={{ kind: "user", key: userId }}>, ' +
        'and call the accessor during a component body, not inside a timeout ' +
        'or an async callback.'
    )
  }
  return value
}

/**
 * True when a provider is already mounted above this one, which silently
 * shadows the outer client for the whole subtree.
 */
export function hasAvsbContext(): boolean {
  return useContext(AvsbContext) !== NOT_IN_PROVIDER
}
