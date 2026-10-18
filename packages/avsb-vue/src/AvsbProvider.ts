/**
 * <AvsbProvider>: the one place a Vue app wires up A vs B.
 *
 * Written with `defineComponent` + a render function so the published bundle
 * needs no SFC compiler (the same trick pinia and vue-router use). The
 * companion `AvsbProvider.vue` is a readable copy of this component for
 * anyone who prefers to paste it into their own app.
 *
 * Mode A: pass `sdk-key` (plus optional `context`, `bootstrap`, `options`).
 *   The provider builds the client and closes it on unmount.
 * Mode B: pass `client`. The provider never closes it; you own its lifetime.
 */
import { defineComponent, onUnmounted, provide, type PropType } from 'vue'
import { isDevEnvironment } from '@avsbhq/browser'
import { consoleLogger } from '@avsbhq/core'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'
import { AvsbInjectionKey, hasAvsbContext } from './context'
import type { VueAvsbClient } from './clientInterface'
import { createProviderState } from './internal/providerState'
import { resolveClient } from './internal/resolveClient'
import type { AvsbProviderOptions, AvsbProviderProps } from './types'

const NESTED_PROVIDER_WARNING =
  '[avsb] <AvsbProvider> is nested inside another <AvsbProvider>. The inner ' +
  'one shadows the outer for everything below it, so two clients are now ' +
  'running, each with its own visitor id and its own event queue. Mount one ' +
  'provider at the root of the app unless you meant to isolate a subtree.'

export const AvsbProvider = defineComponent({
  name: 'AvsbProvider',

  props: {
    /** Mode B: a client you built and own. */
    client: {
      type: Object as PropType<VueAvsbClient>,
      default: undefined,
    },
    /** Mode A: the environment's SDK key. */
    sdkKey: {
      type: String,
      default: undefined,
    },
    /** Mode A: evaluation context. Omit for an anonymous visitor. */
    context: {
      type: Object as PropType<EvalContext>,
      default: undefined,
    },
    /** Mode A: a datafile fetched on the server, for a real first paint. */
    bootstrap: {
      type: Object as PropType<FlagDatafile>,
      default: undefined,
    },
    /** Mode A: everything else AvsbClient accepts. */
    options: {
      type: Object as PropType<AvsbProviderOptions>,
      default: undefined,
    },
  },

  setup(props, { slots }) {
    if (hasAvsbContext() && isDevEnvironment()) {
      consoleLogger('warn').warn(NESTED_PROVIDER_WARNING)
    }

    const { client, owned } = resolveClient(props as AvsbProviderProps)
    const state = createProviderState(client)

    provide(AvsbInjectionKey, {
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

    onUnmounted(() => {
      state.stop()
      // Mode A owns the client; in Mode B the caller does.
      if (owned) void client.close()
    })

    return () => slots.default?.()
  },
})
