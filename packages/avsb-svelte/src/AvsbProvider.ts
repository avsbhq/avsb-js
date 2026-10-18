/**
 * The provider, as a function.
 *
 * `AvsbProvider.svelte` is a five-line wrapper around this, so the SFC and
 * the programmatic form cannot drift. Use this one directly when you want the
 * context set from a layout script, a custom provider component, or a test:
 *
 *   <script lang="ts">
 *     import { createAvsbContext } from '@avsbhq/svelte'
 *     import { onDestroy } from 'svelte'
 *
 *     const { cleanup } = createAvsbContext({
 *       sdkKey: PUBLIC_AVSB_SDK_KEY,
 *       context: { kind: 'user', key: data.userId },
 *     })
 *     onDestroy(cleanup)
 *   </script>
 *
 * Mode A (an `sdkKey`): this builds the client and `cleanup()` closes it.
 * Mode B (a `client`): you own it, and `cleanup()` only detaches listeners.
 */
import { isDevEnvironment } from '@avsbhq/browser'
import { consoleLogger } from '@avsbhq/core'
import type { SvelteAvsbClient } from './clientInterface'
import {
  hasAvsbContext,
  setAvsbContext,
  type AvsbContextValue,
} from './context'
import { createProviderState } from './internal/providerState'
import { resolveClient } from './internal/resolveClient'
import type { AvsbProviderProps } from './types'

export type CreateAvsbContextOptions = AvsbProviderProps

export interface CreateAvsbContextResult {
  /** The same value child components read with the store factories. */
  contextValue: AvsbContextValue
  /** The client, so a layout can bootstrap or flush it directly. */
  client: SvelteAvsbClient
  /** Call in `onDestroy`. Closes the client in Mode A only. */
  cleanup: () => void
}

const NESTED_PROVIDER_WARNING =
  '[avsb] AvsbProvider is nested inside another AvsbProvider. The inner one ' +
  'shadows the outer for everything below it, so two clients are now ' +
  'running, each with its own visitor id and its own event queue. Mount one ' +
  'provider at the root of the app unless you meant to isolate a subtree.'

/**
 * Build the client and the context value, and start tracking readiness,
 * WITHOUT touching Svelte's context.
 *
 * This is the half that works anywhere: a test, a load function, a plain
 * module. Pass the returned `contextValue` to any store as its last argument.
 */
export function buildAvsbContext(
  options: CreateAvsbContextOptions
): CreateAvsbContextResult {
  const { client, owned } = resolveClient(options)
  const state = createProviderState(client)

  const contextValue: AvsbContextValue = {
    client,
    get status() {
      return state.snapshot().status
    },
    get error() {
      return state.snapshot().error
    },
    get degraded() {
      return state.snapshot().degraded
    },
    onStatusChange: state.onChange,
  }

  return {
    contextValue,
    client,
    cleanup: (): void => {
      state.stop()
      if (owned) void client.close()
    },
  }
}

/**
 * Build the client, set the Svelte context, and start tracking readiness.
 *
 * Must be called during a component's initialisation (before `onMount`), the
 * same rule Svelte's own `setContext` has.
 */
export function createAvsbContext(
  options: CreateAvsbContextOptions
): CreateAvsbContextResult {
  if (hasAvsbContext() && isDevEnvironment()) {
    consoleLogger('warn').warn(NESTED_PROVIDER_WARNING)
  }

  const result = buildAvsbContext(options)
  setAvsbContext(result.contextValue)
  return result
}
