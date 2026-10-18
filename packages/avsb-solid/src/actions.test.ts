/**
 * The imperative accessors, against the REAL browser client.
 *
 * The exposure tests are the ones that matter: an exposure is a claim about
 * what a visitor saw, so firing twice (or firing for a component that was
 * torn down before the SDK was ready) corrupts the results customers act on.
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
  createExposure,
  createFlagSubscription,
  useAlias,
  useIdentify,
  useReset,
  useTrack,
} from './actions'

const LATER = '2024-06-01T00:00:00.000Z'

function context(client: SolidAvsbClient): AvsbContextValue {
  return {
    client,
    status: () => 'ready',
    error: () => undefined,
    degraded: () => false,
  }
}

function notReadyClient(): AvsbClient {
  return new AvsbClient({
    sdkKey: 'sdk_test_0000000000000000000',
    autoInit: false,
    autoRefresh: false,
    cache: false,
    logLevel: 'silent',
  })
}

describe('identity and tracking', () => {
  it('useTrack queues the event against the client', () => {
    const client = createTestClient()
    const track = vi.spyOn(client, 'track')

    const { result, dispose } = runWithAvsbContext(context(client), () =>
      useTrack()
    )
    result('checkout_started', { value: 99 })

    expect(track).toHaveBeenCalledWith('checkout_started', { value: 99 })
    dispose()
  })

  it('useIdentify replaces the evaluation context', () => {
    const client = createTestClient()
    const { result, dispose } = runWithAvsbContext(context(client), () =>
      useIdentify()
    )

    result({ kind: 'user', key: 'u_42', plan: 'pro' })

    expect(client.getContext()).toMatchObject({ key: 'u_42', plan: 'pro' })
    dispose()
  })

  it('useAlias queues one avsb_alias event and returns nothing to await', () => {
    const client = createTestClient()
    const track = vi.spyOn(client, 'track')

    const { result, dispose } = runWithAvsbContext(context(client), () =>
      useAlias()
    )
    const returned = result(
      { kind: 'user', key: 'anon' },
      { kind: 'user', key: 'u_1' }
    )

    expect(returned).toBeUndefined()
    // The conversion wire has no properties column, so alias queues the bare event.
    expect(track).toHaveBeenCalledWith('avsb_alias')
    dispose()
  })

  it('useReset rotates to a new anonymous identity', () => {
    const client = createTestClient({ context: { kind: 'user', key: 'u_1' } })
    const { result, dispose } = runWithAvsbContext(context(client), () =>
      useReset()
    )

    result()

    expect(client.getContext().key).not.toBe('u_1')
    dispose()
  })
})

describe('createExposure', () => {
  it('records EXACTLY ONE exposure per mount', () => {
    // Regression: pairing onMount with a tracking createEffect fired twice,
    // because onMount IS a createEffect in Solid and effects flush in
    // creation order. Two non read-only reads with no dedupe behind them
    // doubled every count in the results.
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    const { dispose } = runWithAvsbContext(context(client), () => {
      createExposure('checkout-v2')
    })

    expect(exposures).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('records one more exposure when a reactive key changes', () => {
    const client = createTestClient({ flags: { 'flag-a': true, 'flag-b': true } })
    const exposures = vi.fn()
    client.on('exposure', exposures)
    const [key, setKey] = createSignal('flag-a')

    const { dispose } = runWithAvsbContext(context(client), () => {
      createExposure(key)
    })
    expect(exposures).toHaveBeenCalledTimes(1)

    setKey('flag-b')

    expect(exposures).toHaveBeenCalledTimes(2)
    dispose()
  })

  it('defers past a not-ready client and still fires once', () => {
    const client = notReadyClient()
    const exposures = vi.fn()
    client.on('exposure', exposures)

    const { dispose } = runWithAvsbContext(context(client), () => {
      createExposure('checkout-v2')
    })
    expect(exposures).not.toHaveBeenCalled()

    client.applyDatafileBootstrap(createTestDatafile({ 'checkout-v2': true }))

    expect(exposures).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('records nothing when the owner is disposed before the SDK is ready', () => {
    const client = notReadyClient()
    const exposures = vi.fn()
    client.on('exposure', exposures)

    const { dispose } = runWithAvsbContext(context(client), () => {
      createExposure('checkout-v2')
    })
    dispose()

    client.applyDatafileBootstrap(createTestDatafile({ 'checkout-v2': true }))

    expect(exposures).not.toHaveBeenCalled()
  })
})

describe('createFlagSubscription', () => {
  it('runs a side effect on change and stops on dispose', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const seen: Flag[] = []

    const { dispose } = runWithAvsbContext(context(client), () => {
      createFlagSubscription('checkout-v2', (flag) => seen.push(flag))
    })

    client.applyDatafileBootstrap(
      createTestDatafile({ 'checkout-v2': false }, { publishedAt: LATER })
    )
    expect(seen).toHaveLength(1)
    expect(seen[0].value).toBe(false)

    dispose()
    client.applyDatafileBootstrap(
      createTestDatafile(
        { 'checkout-v2': true },
        { publishedAt: '2024-07-01T00:00:00.000Z' }
      )
    )
    expect(seen).toHaveLength(1)
  })
})
