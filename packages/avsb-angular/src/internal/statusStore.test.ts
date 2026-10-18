import { describe, expect, it } from 'vitest'
import type { InitResult } from '@avsbhq/core'
import { AvsbStatusStore } from './statusStore'
import { INIT_FAILED_MESSAGE } from './messages'

describe('AvsbStatusStore', () => {
  it('starts loading with no error', () => {
    const store = new AvsbStatusStore()

    expect(store.status()).toBe('loading')
    expect(store.ready()).toBe(false)
    expect(store.degraded()).toBe(false)
    expect(store.error()).toBeNull()
  })

  it('goes ready on a successful init', () => {
    const store = new AvsbStatusStore()

    store.applyInitResult({ success: true, source: 'network' })

    expect(store.status()).toBe('ready')
    expect(store.ready()).toBe(true)
    expect(store.degraded()).toBe(false)
    expect(store.error()).toBeNull()
  })

  it('treats a degraded init as ready with a warning, never as fatal', () => {
    const store = new AvsbStatusStore()
    const staleError = new Error('refresh failed, serving the cached datafile')

    // The client emits 'error' BEFORE it settles a degraded init.
    store.recordError(staleError)
    store.applyInitResult({
      success: true,
      degraded: true,
      source: 'error',
      error: staleError,
    })

    expect(store.status()).toBe('ready')
    expect(store.degraded()).toBe(true)
    expect(store.error()).toBe(staleError)
  })

  it('reports a failed init as error and keeps the actionable message', () => {
    const store = new AvsbStatusStore()
    const failure = new Error('datafile 403 for https://cdn.avsb.cloud/sdk_x/datafile.json')

    store.applyInitResult({ success: false, source: 'error', error: failure })

    expect(store.status()).toBe('error')
    expect(store.ready()).toBe(false)
    expect(store.degraded()).toBe(false)
    expect(store.error()).toBe(failure)
  })

  it('substitutes an actionable message when a failure arrives without one', () => {
    const store = new AvsbStatusStore()

    store.applyInitResult({ success: false, source: 'timeout' })

    expect(store.error()?.message).toBe(INIT_FAILED_MESSAGE)
    expect(store.error()?.message).toContain('sdkKey')
  })

  it('lets a later refresh rescue a failed init', () => {
    const store = new AvsbStatusStore()

    store.applyInitResult({ success: false, source: 'error', error: new Error('boom') })
    store.applyInitResult({ success: true, source: 'network' })

    expect(store.status()).toBe('ready')
    expect(store.error()).toBeNull()
  })

  it('ignores a stale failure that arrives after a rescue', () => {
    const store = new AvsbStatusStore()
    // onReady() keeps the FIRST answer forever, so its failed result can
    // land after the 'ready' event that rescued the SDK.
    store.applyInitResult({ success: true, source: 'network' })
    store.applyInitResult({ success: false, source: 'error', error: new Error('late') })

    expect(store.status()).toBe('ready')
    expect(store.error()).toBeNull()
  })

  it('mirrors every value onto its Observable', () => {
    const store = new AvsbStatusStore()
    const seen: string[] = []
    const readySeen: boolean[] = []
    store.status$.subscribe((value) => seen.push(value))
    store.ready$.subscribe((value) => readySeen.push(value))

    store.applyInitResult({ success: true, source: 'network' })

    expect(seen).toEqual(['loading', 'ready'])
    expect(readySeen).toEqual([false, true])
  })

  it('does not re-emit when a value is set to what it already is', () => {
    const store = new AvsbStatusStore()
    const seen: string[] = []
    store.status$.subscribe((value) => seen.push(value))

    const result: InitResult = { success: true, source: 'network' }
    store.applyInitResult(result)
    store.applyInitResult(result)

    expect(seen).toEqual(['loading', 'ready'])
  })
})
