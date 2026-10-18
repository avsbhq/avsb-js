/**
 * The provider state machine.
 *
 * The case that matters most: a client serving cached flags after a failed
 * refresh emits an `'error'` EVENT while its init result is
 * `{ success: true, degraded: true }`. Treating that event as fatal (what
 * every adapter used to do) blanks a working app.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ClientEventMap, ClientEventName, InitResult } from '@avsbhq/core'
import { createProviderState, type ProviderStateClient } from './providerState'

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
  it('starts ready when the client can already answer', () => {
    const state = createProviderState(fakeClient({ ready: true }))
    expect(state.snapshot().status).toBe('ready')
    state.stop()
  })

  it('settles to ready and notifies listeners', async () => {
    const client = fakeClient()
    const state = createProviderState(client)
    const listener = vi.fn()
    state.onChange(listener)

    expect(state.snapshot().status).toBe('loading')

    client.settle({ success: true, source: 'network' })
    await Promise.resolve()

    expect(state.snapshot().status).toBe('ready')
    expect(listener).toHaveBeenCalled()
    state.stop()
  })

  it('settles to error with the SDK error when nothing could be loaded', async () => {
    const client = fakeClient()
    const state = createProviderState(client)
    const failure = new Error('404 from https://cdn.avsb.cloud/sdk_x/datafile.json')

    client.settle({ success: false, source: 'error', error: failure })
    await Promise.resolve()

    expect(state.snapshot()).toEqual({
      status: 'error',
      error: failure,
      degraded: false,
    })
    state.stop()
  })

  it('reports degraded, NOT error, when a refresh fails while flags answer', async () => {
    const client = fakeClient({
      ready: true,
      initResult: { success: true, degraded: true, source: 'error' },
    })
    const state = createProviderState(client)

    client.emitError(new Error('refresh failed: network unreachable'))
    await Promise.resolve()

    const snapshot = state.snapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.degraded).toBe(true)
    expect(snapshot.error?.message).toContain('refresh failed')
    state.stop()
  })

  it('escalates an error event while nothing is readable', async () => {
    const client = fakeClient({ ready: false })
    const state = createProviderState(client)

    client.emitError(new Error('datafile fetch failed'))
    await Promise.resolve()

    expect(state.snapshot().status).toBe('error')
    state.stop()
  })

  it('ignores events and drops listeners after stop()', async () => {
    const client = fakeClient({ ready: true })
    const state = createProviderState(client)
    const listener = vi.fn()
    state.onChange(listener)

    state.stop()
    client.emitError(new Error('after teardown'))
    await Promise.resolve()

    expect(state.snapshot().error).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
  })
})
