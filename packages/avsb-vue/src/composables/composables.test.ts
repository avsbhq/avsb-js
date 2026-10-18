/**
 * Composable behaviour against the real browser client.
 *
 * No component is mounted and nothing asserts on markup: each composable is
 * run inside an `effectScope`, which is the same subscribe-and-dispose path a
 * component takes.
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import type { Flag } from '@avsbhq/core'
import { createTestClient, createTestDatafile } from '../testing'
import { contextValue, runComposable } from '../testHarness'
import { useFlagValue } from './useFlagValue'
import { useBoolFlag } from './useBoolFlag'
import { useStringFlag } from './useStringFlag'
import { useNumberFlag } from './useNumberFlag'
import { useJsonFlag } from './useJsonFlag'
import { useAllFlags } from './useAllFlags'
import { useFlagReady } from './useFlagReady'
import { useAvsbStatus } from './useAvsbStatus'
import { useTrack } from './useTrack'
import { useIdentify } from './useIdentify'
import { useAlias } from './useAlias'
import { useReset } from './useReset'
import { useFlagSubscription } from './useFlagSubscription'

const LATER = '2024-06-01T00:00:00.000Z'

describe('typed composables', () => {
  it('useFlagValue unwraps to the raw value', () => {
    const client = createTestClient({ flags: { 'promo-banner': 'blue' } })
    const { result, stop } = runComposable(contextValue(client), () =>
      useFlagValue('promo-banner', 'grey')
    )

    expect(result.value).toBe('blue')
    stop()
  })

  it('typed reads return the platform value for the matching type', () => {
    const client = createTestClient({
      flags: {
        'dark-mode': true,
        theme: 'dark',
        'max-items': 25,
        'api-config': { timeout: 1000 },
      },
    })
    const ctx = contextValue(client)

    const bool = runComposable(ctx, () => useBoolFlag('dark-mode', false))
    const str = runComposable(ctx, () => useStringFlag('theme', 'light'))
    const num = runComposable(ctx, () => useNumberFlag('max-items', 10))
    const json = runComposable(ctx, () =>
      useJsonFlag<{ timeout: number }>('api-config', { timeout: 5000 })
    )

    expect(bool.result.value.value).toBe(true)
    expect(str.result.value.value).toBe('dark')
    expect(num.result.value.value).toBe(25)
    expect(json.result.value.value.timeout).toBe(1000)

    bool.stop()
    str.stop()
    num.stop()
    json.stop()
  })

  it('a typed read of the wrong type falls back to the default instead of throwing', () => {
    const client = createTestClient({ flags: { theme: 'dark' } })
    const { result, stop } = runComposable(contextValue(client), () =>
      useNumberFlag('theme', 42)
    )

    expect(result.value.value).toBe(42)
    expect(result.value.source).toBe('not_found')
    stop()
  })

  it('typed reads fire no exposure during render', () => {
    const client = createTestClient({ flags: { 'dark-mode': true } })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    const { result, stop } = runComposable(contextValue(client), () =>
      useBoolFlag('dark-mode', false)
    )
    void result.value.value
    void result.value.value

    expect(exposures).not.toHaveBeenCalled()
    stop()
  })
})

describe('useAllFlags', () => {
  it('returns every flag and refreshes when the datafile is republished', () => {
    const client = createTestClient({ flags: { a: true, b: 'two' } })
    const { result, stop } = runComposable(contextValue(client), () =>
      useAllFlags()
    )

    expect(Object.keys(result.value).sort()).toEqual(['a', 'b'])

    client.applyDatafileBootstrap(
      createTestDatafile({ a: true, b: 'two', c: 3 }, { publishedAt: LATER })
    )

    expect(Object.keys(result.value).sort()).toEqual(['a', 'b', 'c'])
    stop()
  })

  it('fires no exposures for a bulk read', () => {
    const client = createTestClient({ flags: { a: true } })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    const { result, stop } = runComposable(contextValue(client), () =>
      useAllFlags()
    )
    void result.value

    expect(exposures).not.toHaveBeenCalled()
    stop()
  })
})

describe('useFlagReady and useAvsbStatus', () => {
  it('reports ready and no error for a healthy client', () => {
    const client = createTestClient()
    const ctx = contextValue(client)

    const ready = runComposable(ctx, () => useFlagReady())
    const status = runComposable(ctx, () => useAvsbStatus())

    expect(ready.result.value).toBe(true)
    expect(status.result.status.value).toBe('ready')
    expect(status.result.error.value).toBeUndefined()
    expect(status.result.degraded.value).toBe(false)

    ready.stop()
    status.stop()
  })

  it('reports a degraded client as ready, with the error attached', () => {
    const client = createTestClient()
    const staleness = new Error('refresh failed')
    const ctx = contextValue(client, {
      status: 'ready',
      degraded: true,
      error: staleness,
    })

    const ready = runComposable(ctx, () => useFlagReady())
    const status = runComposable(ctx, () => useAvsbStatus())

    expect(ready.result.value).toBe(true)
    expect(status.result.degraded.value).toBe(true)
    expect(status.result.error.value).toBe(staleness)

    ready.stop()
    status.stop()
  })

  it('reports a failed init as not ready', () => {
    const client = createTestClient()
    const ctx = contextValue(client, {
      status: 'error',
      error: new Error('nothing loaded'),
    })

    const ready = runComposable(ctx, () => useFlagReady())
    expect(ready.result.value).toBe(false)
    ready.stop()
  })
})

describe('action composables', () => {
  it('useTrack queues the event against the client', () => {
    const client = createTestClient()
    const track = vi.spyOn(client, 'track')

    const { result, stop } = runComposable(contextValue(client), () =>
      useTrack()
    )
    result('checkout_started', { value: 99 })

    expect(track).toHaveBeenCalledWith('checkout_started', { value: 99 })
    stop()
  })

  it('useIdentify replaces the evaluation context', () => {
    const client = createTestClient()
    const { result, stop } = runComposable(contextValue(client), () =>
      useIdentify()
    )

    result({ kind: 'user', key: 'u_42', plan: 'pro' })

    expect(client.getContext()).toMatchObject({ key: 'u_42', plan: 'pro' })
    stop()
  })

  it('useAlias queues one avsb_alias event and returns nothing to await', () => {
    const client = createTestClient()
    const track = vi.spyOn(client, 'track')

    const { result, stop } = runComposable(contextValue(client), () =>
      useAlias()
    )
    const returned = result({ kind: 'user', key: 'anon' }, { kind: 'user', key: 'u_1' })

    expect(returned).toBeUndefined()
    // The conversion wire has no properties column, so alias queues the bare event.
    expect(track).toHaveBeenCalledWith('avsb_alias')
    stop()
  })

  it('useReset rotates to a new anonymous identity', () => {
    const client = createTestClient({ context: { kind: 'user', key: 'u_1' } })
    const { result, stop } = runComposable(contextValue(client), () =>
      useReset()
    )

    result()

    expect(client.getContext().key).not.toBe('u_1')
    stop()
  })
})

describe('useFlagSubscription', () => {
  it('runs the callback on change and stops on scope disposal', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const seen: Array<Flag> = []

    const { stop } = runComposable(contextValue(client), () => {
      useFlagSubscription('checkout-v2', (flag) => seen.push(flag))
    })

    client.applyDatafileBootstrap(
      createTestDatafile({ 'checkout-v2': false }, { publishedAt: LATER })
    )
    expect(seen).toHaveLength(1)
    expect(seen[0].value).toBe(false)

    stop()
    client.applyDatafileBootstrap(
      createTestDatafile(
        { 'checkout-v2': true },
        { publishedAt: '2024-07-01T00:00:00.000Z' }
      )
    )
    expect(seen).toHaveLength(1)
  })

  it('follows a reactive key', () => {
    const client = createTestClient({ flags: { 'flag-a': true, 'flag-b': true } })
    const key = ref('flag-a')
    const subscribed: string[] = []
    const subscribe = vi
      .spyOn(client, 'subscribe')
      .mockImplementation((flagKey: string) => {
        subscribed.push(flagKey)
        return () => {}
      })

    const { stop } = runComposable(contextValue(client), () => {
      useFlagSubscription(key, () => {})
    })

    key.value = 'flag-b'

    expect(subscribed).toEqual(['flag-a', 'flag-b'])
    subscribe.mockRestore()
    stop()
  })
})
