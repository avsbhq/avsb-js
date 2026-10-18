/**
 * The one subscription implementation both layers share.
 *
 * The store layer and the runes layer call `bindFlag`, so if this is right
 * they agree by construction. `flags.svelte.ts` itself is not imported here:
 * runes have to be compiled by the Svelte compiler, and this package's tests
 * run under the plain TypeScript runner (see the README note).
 */
import { describe, it, expect, vi } from 'vitest'
import { AvsbClient } from '@avsbhq/browser'
import type { Flag } from '@avsbhq/core'
import { createTestClient, createTestDatafile } from '../testing'
import { RENDER_SAFE, bindFlag } from './bindFlag'

const LATER = '2024-06-01T00:00:00.000Z'

describe('bindFlag', () => {
  it('pushes a new value when the flag changes', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const seen: Array<Flag<boolean>> = []

    const stop = bindFlag<boolean>(
      client,
      'checkout-v2',
      (c, key) => c.getSnapshot<boolean>(key, false),
      (flag) => seen.push(flag)
    )

    client.applyDatafileBootstrap(
      createTestDatafile({ 'checkout-v2': false }, { publishedAt: LATER })
    )

    expect(seen).toHaveLength(1)
    expect(seen[0].value).toBe(false)
    stop()
  })

  it('stops pushing after the returned unsubscribe runs', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const onChange = vi.fn()

    const stop = bindFlag<boolean>(
      client,
      'checkout-v2',
      (c, key) => c.getSnapshot<boolean>(key, false),
      onChange
    )
    stop()

    client.applyDatafileBootstrap(
      createTestDatafile({ 'checkout-v2': false }, { publishedAt: LATER })
    )

    expect(onChange).not.toHaveBeenCalled()
  })

  it('fires once when the first datafile lands', () => {
    const client = new AvsbClient({
      sdkKey: 'sdk_test_0000000000000000000',
      autoInit: false,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent',
    })
    const seen: string[] = []

    const stop = bindFlag<boolean>(
      client,
      'checkout-v2',
      (c, key) => c.getSnapshot<boolean>(key, false),
      (flag) => seen.push(flag.source)
    )

    client.applyDatafileBootstrap(createTestDatafile({ 'checkout-v2': true }))

    expect(seen).toEqual(['rule'])
    stop()
  })

  it('RENDER_SAFE reads fire no exposure', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    client.getBoolFlag('checkout-v2', false, RENDER_SAFE)
    client.getBoolFlag('checkout-v2', false, RENDER_SAFE)

    expect(exposures).not.toHaveBeenCalled()
    expect(client.getBoolFlag('checkout-v2', false, RENDER_SAFE)).toBe(
      client.getBoolFlag('checkout-v2', false, RENDER_SAFE)
    )
  })
})
