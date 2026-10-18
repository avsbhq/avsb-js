/**
 * Optional Pinia integration, published as its own entry point:
 *
 *   import { useAvsbStore } from '@avsbhq/vue/pinia'
 *
 * It lives here, and not in the main barrel, because importing the barrel
 * used to pull `pinia` into every Vue app whether or not it used Pinia,
 * which broke module resolution at dev and build time for everyone else
 * (breaking change B9). `pinia` is an optional peer dependency: install it
 * only if you import this entry point.
 *
 * The store reflects the provider: it does not create a client. Use it
 * inside a tree under <AvsbProvider>, or in an app that installed
 * AvsbPlugin. The first component that calls `useAvsbStore()` is what binds
 * it, so that call must happen where the provider context is visible.
 */
import { defineStore } from 'pinia'
import { computed, onScopeDispose, shallowRef, type ComputedRef } from 'vue'
import type { EvalContext, Flag, TrackPayload } from '@avsbhq/core'
import { useAvsbContext } from './context'
import type { VueAvsbClient } from './clientInterface'
import type { AvsbStatus } from './types'

export interface AvsbStoreState {
  /** The client the provider built or adopted. */
  client: ComputedRef<VueAvsbClient>
  status: ComputedRef<AvsbStatus>
  error: ComputedRef<Error | undefined>
  degraded: ComputedRef<boolean>
  /** Every flag, refreshed whenever any flag changes. */
  flags: ComputedRef<Record<string, Flag>>
  identify: (context: EvalContext) => void
  alias: (previousContext: EvalContext, newContext: EvalContext) => void
  reset: () => void
  track: (eventKey: string, payload?: TrackPayload) => void
}

export const useAvsbStore = defineStore('avsb', (): AvsbStoreState => {
  const context = useAvsbContext()
  const client = context.client

  const allFlags = shallowRef<Record<string, Flag>>(client.getAllFlags())
  const unsubscribe = client.on('flagChange', () => {
    allFlags.value = client.getAllFlags()
  })
  onScopeDispose(unsubscribe)

  return {
    client: computed(() => client),
    status: computed(() => context.status),
    error: computed(() => context.error),
    degraded: computed(() => context.degraded),
    flags: computed(() => allFlags.value),

    identify: (evalContext: EvalContext): void => {
      client.identify(evalContext)
    },
    alias: (previousContext: EvalContext, newContext: EvalContext): void => {
      client.alias(previousContext, newContext)
    },
    reset: (): void => {
      client.reset()
    },
    track: (eventKey: string, payload?: TrackPayload): void => {
      client.track(eventKey, payload)
    },
  }
})
