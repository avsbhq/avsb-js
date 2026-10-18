import { ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import type { InitResult } from '@avsbhq/core'
import type { VueAvsbClient } from '../clientInterface'
import type { AvsbStatus } from '../types'

/**
 * The slice of the client the state machine touches. Narrow on purpose: a
 * test can hand it four honest functions instead of a whole fake SDK.
 */
export type ProviderStateClient = Pick<
  VueAvsbClient,
  'isReady' | 'getInitResult' | 'onReady' | 'on'
>

export interface ProviderState {
  status: Ref<AvsbStatus>
  error: ShallowRef<Error | undefined>
  degraded: Ref<boolean>
  /** Detach the listeners. Does NOT close the client. */
  stop: () => void
}

const UNEXPLAINED_FAILURE =
  '[avsb] the SDK could not load a datafile and nothing was cached or ' +
  'bootstrapped, so every flag is returning the default you passed. Check ' +
  'the SDK key on app.avsb.cloud under Environments in the project sidebar.'

/**
 * The provider state machine, shared by <AvsbProvider> and AvsbPlugin.
 *
 * Two rules make the difference between "honest" and the old behaviour:
 *
 * 1. Readiness is read synchronously first (`isReady()`), so a client built
 *    with a bootstrap datafile is `'ready'` on the very first render instead
 *    of flashing `'loading'` for a microtask.
 * 2. An `'error'` EVENT is only fatal when nothing is readable. A failed
 *    refresh on a client that is still serving cached flags is `degraded`,
 *    not broken (breaking change B1): flags keep working, and the error is
 *    surfaced so the app can say so.
 */
export function createProviderState(client: ProviderStateClient): ProviderState {
  const status = ref<AvsbStatus>(client.isReady() ? 'ready' : 'loading')
  const error = shallowRef<Error | undefined>(undefined)
  const degraded = ref(false)

  let stopped = false

  const applyInitResult = (result: InitResult): void => {
    if (stopped) return
    if (result.success) {
      status.value = 'ready'
      degraded.value = result.degraded === true
      error.value = result.error
      return
    }
    status.value = 'error'
    error.value = result.error ?? new Error(UNEXPLAINED_FAILURE)
  }

  const settled = client.getInitResult()
  if (settled) {
    applyInitResult(settled)
  } else {
    void client.onReady().then(applyInitResult)
  }

  const offError = client.on('error', (e: Error) => {
    if (stopped) return
    error.value = e
    if (client.isReady()) {
      // Flags are still answerable from a bootstrap or the cache: this is a
      // stale-data warning, not a dead SDK.
      degraded.value = true
      return
    }
    status.value = 'error'
  })

  const offReady = client.on('ready', applyInitResult)

  return {
    status,
    error,
    degraded,
    stop: () => {
      stopped = true
      offError()
      offReady()
    },
  }
}
