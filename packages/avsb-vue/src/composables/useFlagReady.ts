import { computed, type ComputedRef } from 'vue'
import { useAvsbContext } from '../context'

/**
 * `true` once flags are readable.
 *
 * A degraded client (serving a cached datafile after a failed refresh) is
 * ready: flags answer, they may be stale. Use `useAvsbStatus` when you need
 * to tell those two apart, or to show the error.
 */
export function useFlagReady(): ComputedRef<boolean> {
  const context = useAvsbContext()
  return computed(() => context.status === 'ready')
}
