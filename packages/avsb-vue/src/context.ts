import { inject, type InjectionKey } from 'vue'
import type { VueAvsbClient } from './clientInterface'
import type { AvsbStatus } from './types'

// -----------------------------------------------------------------------
// The value <AvsbProvider> (or AvsbPlugin) provides.
//
// `client` is NOT nullable: a provider either has a client or throws at
// setup with an actionable message, so no composable has to carry a
// "there is no client" branch that silently returns defaults.
//
// `status` / `error` / `degraded` are plain properties backed by getters
// over refs, so reading them inside a computed tracks them.
// -----------------------------------------------------------------------

export interface AvsbContextValue {
  client: VueAvsbClient
  status: AvsbStatus
  /**
   * The last error the SDK reported. Present while `status` is `'error'`,
   * and also present with `status: 'ready'` when a refresh failed while
   * cached flags are still being served (`degraded`).
   */
  error: Error | undefined
  /** Serving a stale bootstrap or cached datafile after a failed refresh. */
  degraded: boolean
}

export const AvsbInjectionKey: InjectionKey<AvsbContextValue> =
  Symbol('avsb-injection-key')

/**
 * Read the provider context. Throws when called outside a provider, naming
 * the fix in Vue's own syntax.
 *
 * Internal to the package: every public composable calls it.
 */
export function useAvsbContext(): AvsbContextValue {
  const value = inject(AvsbInjectionKey)
  if (value === undefined) {
    throw new Error(
      '[avsb] composables must be used inside <AvsbProvider> or app.use(AvsbPlugin). ' +
        'Wrap your component tree with ' +
        '<AvsbProvider sdk-key="sdk_production_..." :context="{ kind: \'user\', key: userId }">, ' +
        'or install the plugin with ' +
        "app.use(AvsbPlugin, { sdkKey: 'sdk_production_...' })."
    )
  }
  return value
}

/**
 * True when a provider is already mounted above this one. Used by the
 * provider to warn about nesting, which silently shadows the outer client.
 */
export function hasAvsbContext(): boolean {
  return inject(AvsbInjectionKey, null) !== null
}
