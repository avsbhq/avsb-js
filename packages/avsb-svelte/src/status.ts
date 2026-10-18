/**
 * Readiness and failure stores.
 *
 * Both re-emit when the provider's status moves, which is the whole point:
 * the previous `flagReady` listened for error events only, so it never
 * flipped to true when the SDK became ready.
 */
import { readable, type Readable } from 'svelte/store'
import { useAvsbContext, type AvsbContextValue } from './context'
import type { AvsbStatusValue } from './types'

/**
 * `true` once flags are readable.
 *
 * A degraded client (serving a cached datafile after a failed refresh) is
 * ready: flags answer, they may be stale. Use `avsbStatus` when you need to
 * tell those two apart, or to show the error.
 */
export function flagReady(ctx?: AvsbContextValue): Readable<boolean> {
  const context = ctx ?? useAvsbContext()

  return readable<boolean>(context.status === 'ready', (set) => {
    set(context.status === 'ready')
    return context.onStatusChange(() => {
      set(context.status === 'ready')
    })
  })
}

/**
 * The provider's status, error, and staleness:
 *
 *   {#if $avsb.status === 'loading'}<Skeleton />{/if}
 *   {#if $avsb.degraded}<StaleNotice message={$avsb.error?.message} />{/if}
 *
 * `status: 'error'` means nothing loaded and every flag is returning the
 * default you passed; `error.message` names the HTTP status, the URL tried,
 * and the fix.
 */
export function avsbStatus(ctx?: AvsbContextValue): Readable<AvsbStatusValue> {
  const context = ctx ?? useAvsbContext()

  const snapshot = (): AvsbStatusValue => ({
    status: context.status,
    error: context.error,
    degraded: context.degraded,
  })

  return readable<AvsbStatusValue>(snapshot(), (set) => {
    set(snapshot())
    return context.onStatusChange(() => {
      set(snapshot())
    })
  })
}
