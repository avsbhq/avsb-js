import { createMemo, type Accessor } from 'solid-js'
import { useAvsbContext } from './context'
import type { AvsbStatus } from './types'

/**
 * `true` once flags are readable.
 *
 * A degraded client (serving a cached datafile after a failed refresh) is
 * ready: flags answer, they may be stale. Use `useAvsbStatus` when you need
 * to tell those two apart, or to show the error.
 */
export function createFlagReady(): Accessor<boolean> {
  const { status } = useAvsbContext()
  return createMemo(() => status() === 'ready')
}

export interface UseAvsbStatusResult {
  status: Accessor<AvsbStatus>
  /**
   * The last error the SDK reported. Present with `status() === 'error'`, and
   * also with `status() === 'ready'` when `degraded()` is true.
   */
  error: Accessor<Error | undefined>
  /**
   * `true` when flags are being served from a bootstrap or the cache after a
   * refresh failed. Values still answer; they may be stale.
   */
  degraded: Accessor<boolean>
}

/**
 * The provider's status, error, and staleness:
 *
 *   const { status, error, degraded } = useAvsbStatus()
 *
 * `status() === 'error'` means nothing loaded and every flag is returning the
 * default you passed; `error()?.message` names the HTTP status, the URL
 * tried, and the fix.
 */
export function useAvsbStatus(): UseAvsbStatusResult {
  const { status, error, degraded } = useAvsbContext()
  return { status, error, degraded }
}
