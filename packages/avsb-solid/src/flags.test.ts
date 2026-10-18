/**
 * Flag and status accessors, against the REAL browser client.
 *
 * No component is rendered and no JSX is compiled: each accessor runs inside
 * a reactive root that carries the provider context, which is the same code
 * path a component takes. The imperative accessors (track, identify,
 * exposure, subscription) live in ./actions.test.ts.
 */
import { describe, it, expect, vi } from 'vitest'
import { createSignal } from 'solid-js'
import { AvsbClient } from '@avsbhq/browser'
import type { Flag } from '@avsbhq/core'
import { createTestClient, createTestDatafile } from './testFixtures'
import { runWithAvsbContext } from './testHarness'
import type { AvsbContextValue } from './context'
import type { SolidAvsbClient } from './clientInterface'
import {
  createFlag,
  createFlagValue,
  createBoolFlag,
  createStringFlag,
  createNumberFlag,
  createJsonFlag,
  createAllFlags,
} from './flags'
import { createFlagReady, useAvsbStatus } from './status'

const LATER = '2024-06-01T00:00:00.000Z'

function context(
  client: SolidAvsbClient,
  overrides?: Partial<Omit<AvsbContextValue, 'client'>>
): AvsbContextValue {
  return {
    client,
    status: overrides?.status ?? (() => 'ready'),
    error: overrides?.error ?? (() => undefined),
    degraded: overrides?.degraded ?? (() => false),
  }
}

describe('createFlag', () => {
  it('reads the real value on the first pass, with no await', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const { result, dispose } = runWithAvsbContext(context(client), () =>
      createFlag('checkout-v2', false)
    )

    expect(result().value).toBe(true)
    expect(result().source).toBe('rule')
    expect(result().isEnabled()).toBe(true)
    dispose()
  })

  it('returns the SAME frozen object until the value changes', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const { result, dispose } = runWithAvsbContext(context(client), () =>
      createFlag('checkout-v2', false)
    )

    const first: Flag<boolean> = result()
    expect(result()).toBe(first)

    client.applyDatafileBootstrap(
      createTestDatafile({ 'checkout-v2': false }, { publishedAt: LATER })
    )

    expect(result()).not.toBe(first)
    expect(result().value).toBe(false)
    dispose()
  })

  it('wakes up when the first datafile arrives (not_ready to a real value)', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_test_0000000000000000000',
      autoInit: false,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent',
    })
    const { result, dispose } = runWithAvsbContext(context(client), () =>
      createFlag('checkout-v2', false)
    )

    expect(result().source).toBe('not_ready')
    expect(result().exists()).toBe(false)

    client.applyDatafileBootstrap(createTestDatafile({ 'checkout-v2': true }))

    expect(result().source).toBe('rule')
    expect(result().value).toBe(true)
    dispose()
  })

  it('re-subscribes when a reactive key changes', () => {
    const client = createTestClient({
      flags: { 'flag-a': 'alpha', 'flag-b': 'beta' },
    })
    const [key, setKey] = createSignal('flag-a')

    const { result, dispose } = runWithAvsbContext(context(client), () =>
      createFlag(key, 'fallback')
    )

    expect(result().value).toBe('alpha')

    setKey('flag-b')
    expect(result().value).toBe('beta')
    dispose()
  })

  it('unsubscribes when the root is disposed', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const unsubscribe = vi.fn()
    const subscribe = vi
      .spyOn(client, 'subscribe')
      .mockImplementation(() => unsubscribe)

    const { dispose } = runWithAvsbContext(context(client), () =>
      createFlag('checkout-v2', false)
    )
    expect(subscribe).toHaveBeenCalledWith('checkout-v2', expect.any(Function))

    dispose()
    expect(unsubscribe).toHaveBeenCalled()
    subscribe.mockRestore()
  })

  it('records no exposure while rendering', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    const { result, dispose } = runWithAvsbContext(context(client), () =>
      createFlag('checkout-v2', false)
    )
    void result()
    void result()

    expect(exposures).not.toHaveBeenCalled()
    dispose()
  })
})

describe('typed accessors', () => {
  it('return the platform value for the matching type', () => {
    const client = createTestClient({
      flags: {
        'dark-mode': true,
        theme: 'dark',
        'max-items': 25,
        'api-config': { timeout: 1000 },
      },
    })

    const run = runWithAvsbContext(context(client), () => ({
      bool: createBoolFlag('dark-mode', false),
      str: createStringFlag('theme', 'light'),
      num: createNumberFlag('max-items', 10),
      json: createJsonFlag<{ timeout: number }>('api-config', { timeout: 5000 }),
      value: createFlagValue('theme', 'light'),
    }))

    expect(run.result.bool().value).toBe(true)
    expect(run.result.str().value).toBe('dark')
    expect(run.result.num().value).toBe(25)
    expect(run.result.json().value.timeout).toBe(1000)
    expect(run.result.value()).toBe('dark')
    run.dispose()
  })

  it('fall back to the default on a type mismatch instead of throwing', () => {
    const client = createTestClient({ flags: { theme: 'dark' } })
    const { result, dispose } = runWithAvsbContext(context(client), () =>
      createNumberFlag('theme', 42)
    )

    expect(result().value).toBe(42)
    expect(result().source).toBe('not_found')
    dispose()
  })

  it('fire no exposure during render', () => {
    const client = createTestClient({ flags: { 'dark-mode': true } })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    const { result, dispose } = runWithAvsbContext(context(client), () =>
      createBoolFlag('dark-mode', false)
    )
    void result()

    expect(exposures).not.toHaveBeenCalled()
    dispose()
  })
})

describe('createAllFlags', () => {
  it('lists every flag and refreshes on a republish', () => {
    const client = createTestClient({ flags: { a: true, b: 'two' } })
    const { result, dispose } = runWithAvsbContext(context(client), () =>
      createAllFlags()
    )

    expect(Object.keys(result()).sort()).toEqual(['a', 'b'])

    client.applyDatafileBootstrap(
      createTestDatafile({ a: true, b: 'two', c: 3 }, { publishedAt: LATER })
    )

    expect(Object.keys(result()).sort()).toEqual(['a', 'b', 'c'])
    dispose()
  })
})

describe('status accessors', () => {
  it('report ready with no error for a healthy client', () => {
    const client = createTestClient()
    const { result, dispose } = runWithAvsbContext(context(client), () => ({
      ready: createFlagReady(),
      status: useAvsbStatus(),
    }))

    expect(result.ready()).toBe(true)
    expect(result.status.status()).toBe('ready')
    expect(result.status.error()).toBeUndefined()
    expect(result.status.degraded()).toBe(false)
    dispose()
  })

  it('report a degraded client as ready, with the error attached', () => {
    const client = createTestClient()
    const staleness = new Error('refresh failed')
    const ctx = context(client, {
      status: () => 'ready',
      degraded: () => true,
      error: () => staleness,
    })

    const { result, dispose } = runWithAvsbContext(ctx, () => ({
      ready: createFlagReady(),
      status: useAvsbStatus(),
    }))

    expect(result.ready()).toBe(true)
    expect(result.status.degraded()).toBe(true)
    expect(result.status.error()).toBe(staleness)
    dispose()
  })

  it('report a failed init as not ready', () => {
    const client = createTestClient()
    const ctx = context(client, { status: () => 'error' })
    const { result, dispose } = runWithAvsbContext(ctx, () =>
      createFlagReady()
    )

    expect(result()).toBe(false)
    dispose()
  })
})
