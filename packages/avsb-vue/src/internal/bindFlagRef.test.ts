/**
 * The store contract, exercised against the REAL browser client.
 *
 * These are the guarantees the browser SDK's README promises framework
 * adapters (identity stability, wake-up on ready, targeted notification, no
 * side effects on read). If any of them regress, every Vue composable in
 * this package quietly serves stale or wrong values, so they are asserted
 * here rather than against a mock that would agree with whatever we wrote.
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { AvsbClient } from '@avsbhq/browser'
import type { Flag } from '@avsbhq/core'
import { createTestClient, createTestDatafile } from '../testing'
import { contextValue, runComposable } from '../testHarness'
import { useFlag } from '../composables/useFlag'

const LATER = '2024-06-01T00:00:00.000Z'

describe('bindFlagRef via useFlag', () => {
  it('reads the real value on the first pass, with no await', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })

    const { result, stop } = runComposable(contextValue(client), () =>
      useFlag('checkout-v2', false)
    )

    expect(result.value.value).toBe(true)
    expect(result.value.source).toBe('rule')
    expect(result.value.isEnabled()).toBe(true)
    stop()
  })

  it('returns the SAME frozen object across reads until the value changes', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })

    const { result, stop } = runComposable(contextValue(client), () =>
      useFlag('checkout-v2', false)
    )

    const first: Flag<boolean> = result.value
    const second: Flag<boolean> = result.value
    expect(second).toBe(first)

    client.applyDatafileBootstrap(
      createTestDatafile({ 'checkout-v2': false }, { publishedAt: LATER })
    )

    expect(result.value).not.toBe(first)
    expect(result.value.value).toBe(false)
    stop()
  })

  it('wakes up when the first datafile arrives (not_ready to a real value)', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_test_0000000000000000000',
      autoInit: false,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent',
    })

    const { result, stop } = runComposable(contextValue(client), () =>
      useFlag('checkout-v2', false)
    )

    expect(result.value.source).toBe('not_ready')
    expect(result.value.value).toBe(false)
    expect(result.value.exists()).toBe(false)

    client.applyDatafileBootstrap(createTestDatafile({ 'checkout-v2': true }))

    expect(result.value.source).toBe('rule')
    expect(result.value.value).toBe(true)
    stop()
  })

  it('re-subscribes when a reactive key changes', () => {
    const client = createTestClient({
      flags: { 'flag-a': 'alpha', 'flag-b': 'beta' },
    })
    const key = ref('flag-a')

    const { result, stop } = runComposable(contextValue(client), () =>
      useFlag(key, 'fallback')
    )

    expect(result.value.value).toBe('alpha')

    key.value = 'flag-b'
    expect(result.value.value).toBe('beta')
    stop()
  })

  it('unsubscribes when the scope is disposed', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const unsubscribe = vi.fn()
    const subscribe = vi
      .spyOn(client, 'subscribe')
      .mockImplementation(() => unsubscribe)

    const { stop } = runComposable(contextValue(client), () =>
      useFlag('checkout-v2', false)
    )

    expect(subscribe).toHaveBeenCalledWith('checkout-v2', expect.any(Function))
    expect(unsubscribe).not.toHaveBeenCalled()

    stop()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    subscribe.mockRestore()
  })

  it('records no exposure while reading during render', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    const { result, stop } = runComposable(contextValue(client), () =>
      useFlag('checkout-v2', false)
    )

    // Several reads, the way a re-render would.
    void result.value.value
    void result.value.value
    void result.value.value

    expect(exposures).not.toHaveBeenCalled()
    stop()
  })
})
