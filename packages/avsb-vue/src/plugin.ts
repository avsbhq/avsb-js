/**
 * AvsbPlugin: the `app.use()` form of <AvsbProvider>.
 *
 *   // Mode A: the plugin builds and owns the client
 *   app.use(AvsbPlugin, {
 *     sdkKey: 'sdk_production_...',
 *     context: { kind: 'user', key: userId },
 *   })
 *
 *   // Mode B: you built the client, you own it
 *   app.use(AvsbPlugin, { client })
 *
 * Identical semantics to the component, provided at app level instead of at
 * a subtree, which is what you want when the whole app reads flags.
 */
import type { App, Plugin } from 'vue'
import type { AvsbClientOptions } from '@avsbhq/browser'
import { AvsbInjectionKey } from './context'
import type { VueAvsbClient } from './clientInterface'
import { createProviderState } from './internal/providerState'
import { resolveClient } from './internal/resolveClient'
import type { AvsbProviderProps } from './types'

export type AvsbPluginOptions =
  | (AvsbClientOptions & { client?: never })
  | { client: VueAvsbClient }

export const AvsbPlugin: Plugin<AvsbPluginOptions> = {
  install(app: App, options: AvsbPluginOptions) {
    const { sdkKey, context, bootstrap, client: injected, ...rest } =
      options as AvsbClientOptions & { client?: VueAvsbClient }

    const { client, owned } = resolveClient({
      ...(injected ? { client: injected } : { sdkKey }),
      ...(context !== undefined ? { context } : {}),
      ...(bootstrap !== undefined ? { bootstrap } : {}),
      options: rest,
    } as AvsbProviderProps)

    const state = createProviderState(client)

    app.provide(AvsbInjectionKey, {
      client,
      get status() {
        return state.status.value
      },
      get error() {
        return state.error.value
      },
      get degraded() {
        return state.degraded.value
      },
    })

    // App teardown ALWAYS detaches the state machine's listeners, in both
    // modes: skipping it in Mode B left `ready` and `error` listeners on a
    // client the caller keeps using, so an app mounted and unmounted twice
    // (tests, micro-frontends) accumulated them.
    //
    // Closing the client is the part that depends on ownership: Mode A built
    // it, so teardown flushes and closes it; in Mode B the caller decides.
    const unmount = app.unmount.bind(app)
    app.unmount = (): void => {
      state.stop()
      if (owned) void client.close()
      unmount()
    }
  },
}
