/**
 * Store behaviour against the REAL browser client.
 *
 * The stores are plain functions over `svelte/store`, so nothing is rendered
 * and nothing is compiled: each test subscribes the way a component would and
 * asserts on the values that come out.
 */
import { describe, it, expect, vi } from 'vitest'
import { get } from 'svelte/store'
import { AvsbClient } from '@avsbhq/browser'
import type { Flag } from '@avsbhq/core'
import { buildAvsbContext } from './AvsbProvider'
import type { AvsbContextValue } from './context'
import type { AvsbStatus } from './types'
import {
  createTestClient,
  createTestContextValue,
  createTestDatafile,
} from './testing'
import {
  flag,
  flagValue,
  boolFlag,
  stringFlag,
  numberFlag,
  jsonFlag,
  allFlags,
} from './flags'
import { flagReady, avsbStatus } from './status'
import { subscribeFlag, getTrack, getExposure, getReset } from './actions'

const LATER = '2024-06-01T00:00:00.000Z'

describe('flag stores', () => {
  it('starts with the real value, before anything subscribes', () => {
    const { contextValue } = createTestContextValue({
      flags: { 'checkout-v2': true },
    })

    const store = flag('checkout-v2', false, contextValue)
    const value = get(store)

    expect(value.value).toBe(true)
    expect(value.source).toBe('rule')
    expect(value.isEnabled()).toBe(true)
  })

  it('re-emits when the datafile is republished, and stops on unsubscribe', () => {
    const { contextValue, client } = createTestContextValue({
      flags: { 'checkout-v2': true },
    })
    const seen: boolean[] = []

    const unsubscribe = flag<boolean>('checkout-v2', false, contextValue).subscribe(
      (f) => seen.push(f.value)
    )

    client.applyDatafileBootstrap(
      createTestDatafile({ 'checkout-v2': false }, { publishedAt: LATER })
    )
    expect(seen).toEqual([true, false])

    unsubscribe()
    client.applyDatafileBootstrap(
      createTestDatafile(
        { 'checkout-v2': true },
        { publishedAt: '2024-07-01T00:00:00.000Z' }
      )
    )
    expect(seen).toEqual([true, false])
  })

  it('answers not_ready before any datafile, then wakes up when one lands', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_test_0000000000000000000',
      autoInit: false,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent',
    })
    const { contextValue } = buildAvsbContext({ client })
    const seen: string[] = []

    const unsubscribe = flag('checkout-v2', false, contextValue).subscribe((f) =>
      seen.push(f.source)
    )
    expect(seen).toEqual(['not_ready'])

    client.applyDatafileBootstrap(createTestDatafile({ 'checkout-v2': true }))

    expect(seen).toEqual(['not_ready', 'rule'])
    unsubscribe()
  })

  it('reports a key the datafile does not carry as not_found', () => {
    const { contextValue } = createTestContextValue({ flags: {} })
    const value = get(flag('checkout-v2', false, contextValue))

    expect(value.source).toBe('not_found')
    expect(value.exists()).toBe(false)
    expect(value.value).toBe(false)
  })

  it('flagValue unwraps to the raw value', () => {
    const { contextValue } = createTestContextValue({
      flags: { 'promo-banner': 'blue' },
    })
    expect(get(flagValue('promo-banner', 'grey', contextValue))).toBe('blue')
  })

  it('typed stores return the platform value for the matching type', () => {
    const { contextValue } = createTestContextValue({
      flags: {
        'dark-mode': true,
        theme: 'dark',
        'max-items': 25,
        'api-config': { timeout: 1000 },
      },
    })

    expect(get(boolFlag('dark-mode', false, contextValue)).value).toBe(true)
    expect(get(stringFlag('theme', 'light', contextValue)).value).toBe('dark')
    expect(get(numberFlag('max-items', 10, contextValue)).value).toBe(25)
    expect(
      get(
        jsonFlag<{ timeout: number }>(
          'api-config',
          { timeout: 5000 },
          contextValue
        )
      ).value.timeout
    ).toBe(1000)
  })

  it('a typed read of the wrong type falls back to the default instead of throwing', () => {
    const { contextValue } = createTestContextValue({ flags: { theme: 'dark' } })
    const value = get(numberFlag('theme', 42, contextValue))

    expect(value.value).toBe(42)
    expect(value.source).toBe('not_found')
  })

  it('records no exposure while a component reads the store', () => {
    const { contextValue, client } = createTestContextValue({
      flags: { 'checkout-v2': true },
    })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    const store = boolFlag('checkout-v2', false, contextValue)
    get(store)
    get(store)
    store.subscribe(() => {})()

    expect(exposures).not.toHaveBeenCalled()
  })
})

describe('allFlags', () => {
  it('lists every flag and refreshes on a republish', () => {
    const { contextValue, client } = createTestContextValue({
      flags: { a: true, b: 'two' },
    })
    const seen: Array<string[]> = []

    const unsubscribe = allFlags(contextValue).subscribe((flags) =>
      seen.push(Object.keys(flags).sort())
    )

    client.applyDatafileBootstrap(
      createTestDatafile({ a: true, b: 'two', c: 3 }, { publishedAt: LATER })
    )

    expect(seen[0]).toEqual(['a', 'b'])
    expect(seen[seen.length - 1]).toEqual(['a', 'b', 'c'])
    unsubscribe()
  })
})

describe('flagReady and avsbStatus', () => {
  it('is true immediately for a bootstrapped client', () => {
    const { contextValue } = createTestContextValue({ flags: { a: true } })

    expect(get(flagReady(contextValue))).toBe(true)
    expect(get(avsbStatus(contextValue))).toEqual({
      status: 'ready',
      error: undefined,
      degraded: false,
    })
  })

  it('re-emits when the provider status moves (the old store never did)', () => {
    let status: AvsbStatus = 'loading'
    const listeners = new Set<() => void>()
    const context: AvsbContextValue = {
      client: createTestClient(),
      get status() {
        return status
      },
      get error() {
        return undefined
      },
      get degraded() {
        return false
      },
      onStatusChange: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }

    const seen: boolean[] = []
    const unsubscribe = flagReady(context).subscribe((ready) => seen.push(ready))
    expect(seen).toEqual([false])

    status = 'ready'
    for (const listener of listeners) listener()

    expect(seen).toEqual([false, true])
    unsubscribe()
  })
})

describe('actions', () => {
  it('getTrack queues the event against the client', () => {
    const { contextValue, client } = createTestContextValue()
    const track = vi.spyOn(client, 'track')

    getTrack(contextValue)('checkout_started', { value: 99 })

    expect(track).toHaveBeenCalledWith('checkout_started', { value: 99 })
  })

  it('getExposure records exactly one exposure, and reads do not', () => {
    const { contextValue, client } = createTestContextValue({
      flags: { 'checkout-v2': true },
    })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    get(boolFlag('checkout-v2', false, contextValue))
    expect(exposures).not.toHaveBeenCalled()

    getExposure(contextValue)('checkout-v2')
    expect(exposures).toHaveBeenCalledTimes(1)
  })

  it('getReset rotates to a new anonymous identity', () => {
    const { contextValue, client } = createTestContextValue({
      context: { kind: 'user', key: 'u_1' },
    })

    getReset(contextValue)()

    expect(client.getContext().key).not.toBe('u_1')
  })

  it('subscribeFlag runs a side effect on change and unsubscribes', () => {
    const { contextValue, client } = createTestContextValue({
      flags: { 'checkout-v2': true },
    })
    const seen: Flag[] = []

    const unsubscribe = subscribeFlag(
      'checkout-v2',
      (f) => seen.push(f),
      contextValue
    )

    client.applyDatafileBootstrap(
      createTestDatafile({ 'checkout-v2': false }, { publishedAt: LATER })
    )
    expect(seen).toHaveLength(1)
    expect(seen[0].value).toBe(false)

    unsubscribe()
    client.applyDatafileBootstrap(
      createTestDatafile(
        { 'checkout-v2': true },
        { publishedAt: '2024-07-01T00:00:00.000Z' }
      )
    )
    expect(seen).toHaveLength(1)
  })
})
