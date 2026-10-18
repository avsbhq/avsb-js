/**
 * <AvsbProvider>: the one place a Solid app wires up A vs B.
 *
 * Mode A: pass `sdkKey` (plus any other AvsbClientOptions such as `context`
 *   or `bootstrap`). The provider builds the client and closes it on cleanup.
 * Mode B: pass `client`. The provider never closes it; you own its lifetime.
 *
 *   <AvsbProvider sdkKey={import.meta.env.VITE_AVSB_SDK_KEY} context={ctx}>
 *     <App />
 *   </AvsbProvider>
 */
import { createSignal, onCleanup, type JSX } from 'solid-js'
import { isDevEnvironment } from '@avsbhq/browser'
import { consoleLogger } from '@avsbhq/core'
import { AvsbContext, hasAvsbContext } from './context'
import { createProviderState } from './internal/providerState'
import { resolveClient } from './internal/resolveClient'
import type { AvsbProviderProps, AvsbStatusValue } from './types'

const NESTED_PROVIDER_WARNING =
  '[avsb] <AvsbProvider> is nested inside another <AvsbProvider>. The inner ' +
  'one shadows the outer for everything below it, so two clients are now ' +
  'running, each with its own visitor id and its own event queue. Mount one ' +
  'provider at the root of the app unless you meant to isolate a subtree.'

export function AvsbProvider(props: AvsbProviderProps): JSX.Element {
  if (hasAvsbContext() && isDevEnvironment()) {
    consoleLogger('warn').warn(NESTED_PROVIDER_WARNING)
  }

  const { client, owned } = resolveClient(props)
  const state = createProviderState(client)

  // One signal holding the whole status snapshot: it moves as one unit, so
  // three signals would only be three chances to read a half-applied state.
  const [snapshot, setSnapshot] = createSignal<AvsbStatusValue>(state.snapshot())
  const stopListening = state.onChange(() => setSnapshot(state.snapshot()))

  onCleanup(() => {
    stopListening()
    state.stop()
    // Mode A owns the client; in Mode B the caller does.
    if (owned) void client.close()
  })

  return (
    <AvsbContext.Provider
      value={{
        client,
        status: () => snapshot().status,
        error: () => snapshot().error,
        degraded: () => snapshot().degraded,
      }}
    >
      {props.children}
    </AvsbContext.Provider>
  )
}
