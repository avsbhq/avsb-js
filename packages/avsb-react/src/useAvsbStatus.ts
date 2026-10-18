import { useAvsbContext } from './context'
import type { AvsbStatusState } from './providerStatus'

/**
 * The provider's current state.
 *
 * ```ts
 * function useAvsbStatus(): {
 *   status: 'loading' | 'ready' | 'error'
 *   error?: Error
 *   degraded: boolean
 * }
 * ```
 *
 * - `'loading'`: nothing is readable yet. Every flag read returns your
 *   default with `source: 'not_ready'`.
 * - `'ready'`: flag reads answer with real values.
 * - `'error'`: the init attempt finished with nothing to serve (a wrong
 *   SDK key, a blocked or unreachable CDN). `error.message` names what
 *   failed, the URL or status involved, and where to fix it. Reads keep
 *   returning your defaults, and a later poll can still rescue the client,
 *   at which point this flips to `'ready'` on its own.
 *
 * `degraded` is true when flags are readable but may be stale: a cached or
 * bootstrapped datafile is being served because a refresh failed. That is
 * a warning, not a failure, so `status` stays `'ready'` and `error` holds
 * the refresh failure. It clears itself when a refresh succeeds.
 *
 * ```tsx
 * const { status, error, degraded } = useAvsbStatus()
 * if (status === 'error') return <ErrorBanner message={error?.message} />
 * if (degraded) return <StaleFlagsNotice />
 * ```
 */
export function useAvsbStatus(): AvsbStatusState {
  const { status, error, degraded } = useAvsbContext()
  return { status, error, degraded: degraded === true }
}
