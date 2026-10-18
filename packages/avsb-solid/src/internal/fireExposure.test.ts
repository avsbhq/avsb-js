/**
 * Manual exposure.
 *
 * This is the file `useExposure` (Vue), `getExposure` (Svelte), and
 * `createExposure` (Solid) all delegate to, so the rules are pinned once:
 * one exposure per call, never during a render-safe read, and deferred
 * rather than dropped when the SDK is not ready yet.
 */
import { describe, it, expect, vi } from 'vitest'
import { AvsbClient } from '@avsbhq/browser'
import { createTestClient, createTestDatafile } from '../testFixtures'
import { fireExposureWhenReady } from './fireExposure'

describe('fireExposureWhenReady', () => {
  it('records exactly one exposure when the client is ready', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    fireExposureWhenReady(client, 'checkout-v2')

    expect(exposures).toHaveBeenCalledTimes(1)
  })

  it('names the flag in the exposure it records', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    fireExposureWhenReady(client, 'checkout-v2')

    expect(exposures.mock.calls[0][0]).toMatchObject({
      eventName: 'flag_exposure',
      properties: { flagKey: 'checkout-v2' },
    })
  })

  it('defers the exposure until the SDK is ready instead of dropping it', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_test_0000000000000000000',
      autoInit: false,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent',
    })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    fireExposureWhenReady(client, 'checkout-v2')
    expect(exposures).not.toHaveBeenCalled()

    client.applyDatafileBootstrap(createTestDatafile({ 'checkout-v2': true }))

    expect(exposures).toHaveBeenCalledTimes(1)
  })

  it('cancels a deferred exposure when the caller unmounts first', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_test_0000000000000000000',
      autoInit: false,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent',
    })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    const cancel = fireExposureWhenReady(client, 'checkout-v2')
    cancel()

    client.applyDatafileBootstrap(createTestDatafile({ 'checkout-v2': true }))

    expect(exposures).not.toHaveBeenCalled()
  })

  it('records nothing for a flag that is not part of an experiment', () => {
    // A key the datafile does not carry has no decision to expose.
    const client = createTestClient({ flags: {} })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    fireExposureWhenReady(client, 'missing')

    expect(exposures).not.toHaveBeenCalled()
  })
})
