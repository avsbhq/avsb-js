/**
 * The provider state machine.
 *
 * The case that matters most: a client that is serving cached flags after a
 * failed refresh emits an `'error'` EVENT while its init result is
 * `{ success: true, degraded: true }`. Treating that event as fatal (what
 * every adapter used to do) blanks a working app. These tests pin the rule.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ClientEventMap, ClientEventName, InitResult } from '@avsbhq/core'
import {
  createProviderState,
  type ProviderStateClient,
} from './providerState'

interface FakeClient extends ProviderStateClient {
  emitError: (error: Error) => void
  settle: (result: InitResult) => void
}

function fakeClient(options?: {
  ready?: boolean
  initResult?: InitResult | null
}): FakeClient {
  let ready = options?.ready ?? false
  let initResult: InitResult | null = options?.initResult ?? null
  let resolveReady: (result: InitResult) => void = () => {}
  const readyPromise = new Promise<InitResult>((resolve) => {
    resolveReady = resolve
  })
  const listeners = new Map<string, Set<(payload: never) => void>>()

  return {
    isReady: () => ready,
    getInitResult: () => initResult,
    onReady: () => readyPromise,
    on<E extends ClientEventName>(event: E, cb: ClientEventMap[E]): () => void {
      const set = listeners.get(event) ?? new Set()
      set.add(cb as (payload: never) => void)
      listeners.set(event, set)
      return () => set.delete(cb as (payload: never) => void)
    },
    emitError(error: Error): void {
      for (const cb of listeners.get('error') ?? []) {
        ;(cb as unknown as (e: Error) => void)(error)
      }
    },
    settle(result: InitResult): void {
      initResult = result
      ready = result.success
      resolveReady(result)
    },
  }
}

describe('createProviderState', () => {
  it('starts ready when the client can already answer (bootstrap or cache)', () => {
    const state = createProviderState(fakeClient({ ready: true }))

    expect(state.status.value).toBe('ready')
    expect(state.degraded.value).toBe(false)
    state.stop()
  })

  it('starts loading and settles to ready when init succeeds', async () => {
    const client = fakeClient()
    const state = createProviderState(client)

    expect(state.status.value).toBe('loading')

    client.settle({ success: true, source: 'network' })
    await Promise.resolve()

    expect(state.status.value).toBe('ready')
    expect(state.error.value).toBeUndefined()
    state.stop()
  })

  it('settles to error with the SDK error when nothing could be loaded', async () => {
    const client = fakeClient()
    const state = createProviderState(client)
    const failure = new Error('404 from https://cdn.avsb.cloud/sdk_x/datafile.json')

    client.settle({ success: false, source: 'error', error: failure })
    await Promise.resolve()

    expect(state.status.value).toBe('error')
    expect(state.error.value).toBe(failure)
    state.stop()
  })

  it('reports degraded, NOT error, when a refresh fails while flags still answer', async () => {
    const client = fakeClient({
      ready: true,
      initResult: { success: true, degraded: true, source: 'error' },
    })
    const state = createProviderState(client)

    client.emitError(new Error('refresh failed: network unreachable'))
    await Promise.resolve()

    expect(state.status.value).toBe('ready')
    expect(state.degraded.value).toBe(true)
    expect(state.error.value?.message).toContain('refresh failed')
    state.stop()
  })

  it('escalates an error event to status error while nothing is readable', async () => {
    const client = fakeClient({ ready: false })
    const state = createProviderState(client)

    client.emitError(new Error('datafile fetch failed'))
    await Promise.resolve()

    expect(state.status.value).toBe('error')
    state.stop()
  })

  it('ignores events after stop()', async () => {
    const client = fakeClient({ ready: true })
    const state = createProviderState(client)

    state.stop()
    client.emitError(new Error('after teardown'))
    await Promise.resolve()

    expect(state.error.value).toBeUndefined()
  })

  it('adopts an init result that settled before the provider mounted', () => {
    const settled: InitResult = { success: true, source: 'bootstrap' }
    const onReady = vi.fn(() => Promise.resolve(settled))
    const client: ProviderStateClient = {
      ...fakeClient({ ready: true, initResult: settled }),
      onReady,
    }

    const state = createProviderState(client)

    expect(state.status.value).toBe('ready')
    // No need to await a promise that already settled.
    expect(onReady).not.toHaveBeenCalled()
    state.stop()
  })
})
