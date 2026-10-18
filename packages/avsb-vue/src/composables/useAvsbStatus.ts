import { computed, type ComputedRef } from 'vue'
import { useAvsbContext } from '../context'
import type { AvsbStatus } from '../types'

export interface UseAvsbStatusResult {
  /** `'loading'` | `'ready'` | `'error'`. */
  status: ComputedRef<AvsbStatus>
  /**
   * The last error the SDK reported, if any. Present with `status: 'error'`,
   * and also with `status: 'ready'` when `degraded` is true.
   */
  error: ComputedRef<Error | undefined>
  /**
   * `true` when flags are being served from a bootstrap or the cache after a
   * refresh failed. Values still answer; they may be stale.
   */
  degraded: ComputedRef<boolean>
}

/**
 * The provider's status, error, and staleness, as refs.
 *
 *   const { status, error, degraded } = useAvsbStatus()
 *
 * `status.value === 'error'` means nothing loaded and every flag is
 * returning the default you passed; `error.value.message` names the HTTP
 * status, the URL tried, and the fix.
 */
export function useAvsbStatus(): UseAvsbStatusResult {
  const context = useAvsbContext()
  return {
    status: computed(() => context.status),
    error: computed(() => context.error),
    degraded: computed(() => context.degraded),
  }
}
