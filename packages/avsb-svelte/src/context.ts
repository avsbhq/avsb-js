import { getContext, setContext } from 'svelte'
import type { SvelteAvsbClient } from './clientInterface'
import type { AvsbStatus } from './types'

// -----------------------------------------------------------------------
// The value AvsbProvider puts in Svelte context.
//
// `client` is NOT nullable: a provider either has a client or throws with an
// actionable message, so no store has to carry a "there is no client" branch
// that silently serves defaults.
//
// `status`, `error`, and `degraded` are live getters. `onStatusChange` is how
// stores re-emit when they move, which is what makes `flagReady` and
// `avsbStatus` real stores rather than a value frozen at mount.
// -----------------------------------------------------------------------

export interface AvsbContextValue {
  client: SvelteAvsbClient
  readonly status: AvsbStatus
  /**
   * The last error the SDK reported. Present while `status` is `'error'`, and
   * also present with `status: 'ready'` when a refresh failed while cached
   * flags are still being served (`degraded`).
   */
  readonly error: Error | undefined
  /** Serving a stale bootstrap or cached datafile after a failed refresh. */
  readonly degraded: boolean
  /** Called whenever status, error, or degraded moves. Returns unsubscribe. */
  onStatusChange(listener: () => void): () => void
}

/**
 * The Svelte context key, from the GLOBAL symbol registry on purpose (N1-4).
 *
 * This module exists twice in a real app: once bundled into `dist/` (what the
 * package root, `@avsbhq/svelte`, resolves to) and once as raw source, because
 * `@avsbhq/svelte/AvsbProvider.svelte` and `@avsbhq/svelte/runes` ship from
 * `src/` for the app's own Svelte compiler. A plain `Symbol('avsb-context')`
 * gave each copy its own key, so the documented `<AvsbProvider>` set context
 * under one key, and `boolFlag()` from the package root read under the other
 * and threw "must be called ... inside a tree mounted under AvsbProvider".
 * `Symbol.for` hands every copy the same symbol, and two installed versions of
 * the package as well.
 */
export const AVSB_CONTEXT_KEY: unique symbol = Symbol.for('@avsbhq/svelte:context')

/**
 * Read the provider context. Throws when called outside a component tree
 * mounted under AvsbProvider, naming both fixes.
 *
 * Every store factory takes an optional `ctx` argument that skips this, which
 * is what lets you use them outside a component (a load function, a test, a
 * plain module).
 */
export function useAvsbContext(): AvsbContextValue {
  const value = getContext<AvsbContextValue | undefined>(AVSB_CONTEXT_KEY)
  if (value === undefined) {
    throw new Error(
      '[avsb] the flag stores must be called during component initialisation, ' +
        'inside a tree mounted under AvsbProvider. Wrap your app with ' +
        '<AvsbProvider sdkKey="sdk_production_...">, or call ' +
        'createAvsbContext({ sdkKey }) at the top of a layout script. ' +
        'Outside a component, pass the context explicitly: ' +
        'flag("my_flag", false, ctx).'
    )
  }
  return value
}

/** Set the context value. Called by AvsbProvider and createAvsbContext. */
export function setAvsbContext(value: AvsbContextValue): void {
  setContext(AVSB_CONTEXT_KEY, value)
}

/**
 * True when a provider is already mounted above this one, which silently
 * shadows the outer client for the whole subtree.
 */
export function hasAvsbContext(): boolean {
  return getContext<AvsbContextValue | undefined>(AVSB_CONTEXT_KEY) !== undefined
}
