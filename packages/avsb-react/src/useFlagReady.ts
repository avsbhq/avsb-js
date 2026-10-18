import { useAvsbContext } from './context'

/**
 * Are flag reads answering with real values yet?
 *
 * ```ts
 * function useFlagReady(): boolean
 * ```
 *
 * True as soon as flags are readable from something real: a `bootstrap`
 * datafile, a cached datafile from a previous visit, or a completed fetch.
 * It is the gate you usually want:
 *
 * ```tsx
 * const ready = useFlagReady()
 * if (!ready) return <Skeleton />
 * ```
 *
 * It stays true when the SDK is degraded (serving a cached datafile after
 * a failed refresh), because flags still work. Use `useAvsbStatus()` when
 * you need to tell the difference, or to show the failure message.
 */
export function useFlagReady(): boolean {
  const { status } = useAvsbContext()
  return status === 'ready'
}
