<script setup lang="ts">
/**
 * AvsbProvider.vue: the SFC form, for reference.
 *
 * This file is NOT what the package exports. The published provider is
 * `AvsbProvider.ts` (a `defineComponent`), so the build needs no SFC
 * compiler. This copy exists so you can read the provider as an SFC, or
 * paste it into your own app and change it.
 *
 * Mode A: pass `sdk-key` (plus optional `context`, `bootstrap`, `options`);
 *   this component owns the client and closes it on unmount.
 * Mode B: pass `client`; you own it, and it is never closed here.
 */
import { onUnmounted, provide } from 'vue'
import { isDevEnvironment } from '@avsbhq/browser'
import { consoleLogger } from '@avsbhq/core'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'
import { AvsbInjectionKey, hasAvsbContext } from './context'
import type { VueAvsbClient } from './clientInterface'
import { createProviderState } from './internal/providerState'
import { resolveClient } from './internal/resolveClient'
import type { AvsbProviderOptions, AvsbProviderProps } from './types'

const props = defineProps<{
  client?: VueAvsbClient
  sdkKey?: string
  context?: EvalContext
  bootstrap?: FlagDatafile
  options?: AvsbProviderOptions
}>()

if (hasAvsbContext() && isDevEnvironment()) {
  consoleLogger('warn').warn(
    '[avsb] <AvsbProvider> is nested inside another <AvsbProvider>. The inner ' +
      'one shadows the outer for everything below it, so two clients are now ' +
      'running, each with its own visitor id and its own event queue.'
  )
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
  if (owned) void client.close()
})
</script>

<template>
  <slot />
</template>
