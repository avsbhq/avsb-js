import { onMounted, onUnmounted, watch } from 'vue'
import { useAvsbContext } from '../context'
import { fireExposureWhenReady } from '../internal/fireExposure'
import { resolveFlagKey, type FlagKeyInput } from '../internal/bindFlagRef'

/**
 * Record that this visitor has been shown a flag's decision.
 *
 * Reading a flag during render never records an exposure, which is what
 * keeps a re-render from inflating your results. Call this once, in the
 * component that actually shows the variation, or when the value came from
 * the server as a prop.
 *
 * It fires on mount (never during render or during SSR), or as soon as the
 * SDK becomes ready if it is not yet. A reactive key exposes the new flag
 * when the key changes.
 */
export function useExposure(flagKey: FlagKeyInput): void {
  const { client } = useAvsbContext()

  let cancel: (() => void) | undefined

  const fire = (key: string): void => {
    cancel?.()
    cancel = fireExposureWhenReady(client, key)
  }

  onMounted(() => {
    fire(resolveFlagKey(flagKey))
  })

  if (typeof flagKey !== 'string') {
    watch(flagKey, (next: string) => fire(next))
  }

  onUnmounted(() => {
    cancel?.()
    cancel = undefined
  })
}
