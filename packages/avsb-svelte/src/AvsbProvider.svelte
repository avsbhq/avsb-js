<script lang="ts">
  /**
   * AvsbProvider: mount this once, at the root of your app.
   *
   * Mode A: pass `sdkKey` (plus any other AvsbClientOptions). This component
   *   owns the client and closes it when it is destroyed.
   *
   *   <AvsbProvider sdkKey={PUBLIC_AVSB_SDK_KEY} context={{ kind: 'user', key: userId }}>
   *     {@render children()}
   *   </AvsbProvider>
   *
   * Mode B: pass a client you built. It is never closed here.
   *
   *   <AvsbProvider {client}>{@render children()}</AvsbProvider>
   *
   * The whole implementation is `createAvsbContext`, so this component and
   * the programmatic form cannot drift apart.
   */
  import { onDestroy } from 'svelte'
  import type { Snippet } from 'svelte'
  import { createAvsbContext } from './AvsbProvider'
  import type { AvsbProviderProps } from './types'

  type Props = AvsbProviderProps & { children?: Snippet }

  const { children, ...options }: Props = $props()

  const { cleanup } = createAvsbContext(options as AvsbProviderProps)

  onDestroy(cleanup)
</script>

{@render children?.()}
