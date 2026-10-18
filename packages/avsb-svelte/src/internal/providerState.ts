import type { InitResult } from '@avsbhq/core'
import type { SvelteAvsbClient } from '../clientInterface'
import type { AvsbStatus, AvsbStatusValue } from '../types'

/**
 * The slice of the client the state machine touches. Narrow on purpose: a
 * test can hand it four honest functions instead of a whole fake SDK.
 */
export type ProviderStateClient = Pick<
  SvelteAvsbClient,
  'isReady' | 'getInitResult' | 'onReady' | 'on'
>

export interface ProviderState {
  /** Current status, error, and staleness. */
  snapshot(): AvsbStatusValue
  /** Called whenever the snapshot changes. Returns unsubscribe. */
  onChange(listener: () => void): () => void
  /** Detach the listeners. Does NOT close the client. */
  stop(): void
}

const UNEXPLAINED_FAILURE =
  '[avsb] the SDK could not load a datafile and nothing was cached or ' +
  'bootstrapped, so every flag is returning the default you passed. Check ' +
  'the SDK key on app.avsb.cloud under Environments in the project sidebar.'

/**
 * The provider state machine, shared by AvsbProvider.svelte and
 * createAvsbContext, and framework-free so it can be tested directly.
 *
 * Two rules make the difference between "honest" and the old behaviour:
 *
 * 1. Readiness is read synchronously first (`isReady()`), so a client built
 *    with a bootstrap datafile is `'ready'` on the first render instead of
 *    flashing a loading state.
 * 2. An `'error'` EVENT is only fatal when nothing is readable. A failed
 *    refresh on a client still serving cached flags is `degraded`, not
 *    broken (breaking change B1).
 */
export function createProviderState(client: ProviderStateClient): ProviderState {
  let status: AvsbStatus = client.isReady() ? 'ready' : 'loading'
  let error: Error | undefined
  let degraded = false
  let stopped = false

  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  const applyInitResult = (result: InitResult): void => {
    if (stopped) return
    if (result.success) {
      status = 'ready'
      degraded = result.degraded === true
      error = result.error
    } else {
      status = 'error'
      error = result.error ?? new Error(UNEXPLAINED_FAILURE)
    }
    notify()
  }

  const settled = client.getInitResult()
  if (settled) {
    applyInitResult(settled)
  } else {
    void client.onReady().then(applyInitResult)
  }

  const offError = client.on('error', (e: Error) => {
    if (stopped) return
    error = e
    if (client.isReady()) {
      // Flags still answer from a bootstrap or the cache: stale, not dead.
      degraded = true
    } else {
      status = 'error'
    }
    notify()
  })

  const offReady = client.on('ready', applyInitResult)

  return {
    snapshot: (): AvsbStatusValue => ({ status, error, degraded }),
    onChange: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stop: (): void => {
      stopped = true
      offError()
      offReady()
      listeners.clear()
    },
  }
}
