/**
 * The test helpers are only useful if they behave like production. These
 * tests pin the two properties people will rely on: a flags map evaluates
 * like a fully rolled out A/B rule, and exposure accounting is real.
 */
import { describe, it, expect, vi } from 'vitest'
import { createTestClient, createTestDatafile } from './testing'

describe('createTestDatafile', () => {
  it('types each entry from the value it is given', () => {
    const datafile = createTestDatafile({
      flag: true,
      copy: 'hello',
      count: 3,
      config: { a: 1 },
    })

    const types = Object.fromEntries(
      datafile.flags.map((entry) => [entry.key, entry.type])
    )
    expect(types).toEqual({
      flag: 'boolean',
      copy: 'string',
      count: 'number',
      config: 'json',
    })
  })

  it('points its collect endpoint at a host that cannot resolve', () => {
    expect(createTestDatafile({}).collectEndpoint).toContain('.invalid')
  })

  it('survives a JSON round-trip, so it can be serialised into a page', () => {
    const datafile = createTestDatafile({ 'checkout-v2': true })
    const roundTripped = JSON.parse(JSON.stringify(datafile)) as typeof datafile

    expect(roundTripped).toEqual(datafile)
  })
})

describe('createTestClient', () => {
  it('is ready synchronously, with no fetch', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const client = createTestClient({ flags: { 'checkout-v2': true } })

    expect(client.isReady()).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('serves the flags map as real decisions, so isEnabled() is true', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const flag = client.getBoolFlag('checkout-v2', false, { readOnly: true })

    expect(flag.value).toBe(true)
    expect(flag.source).toBe('rule')
    expect(flag.isEnabled()).toBe(true)
    expect(flag.exists()).toBe(true)
  })

  it('answers not_found for a key the map does not carry', () => {
    const client = createTestClient({ flags: {} })
    const flag = client.getBoolFlag('missing', false, { readOnly: true })

    expect(flag.source).toBe('not_found')
    expect(flag.exists()).toBe(false)
  })

  it('records an exposure for a normal read and none for a render-safe read', () => {
    const client = createTestClient({ flags: { 'checkout-v2': true } })
    const exposures = vi.fn()
    client.on('exposure', exposures)

    client.getBoolFlag('checkout-v2', false, { readOnly: true })
    expect(exposures).not.toHaveBeenCalled()

    client.getBoolFlag('checkout-v2', false)
    expect(exposures).toHaveBeenCalledTimes(1)
  })

  it('evaluates against the context it is given', () => {
    const client = createTestClient({
      flags: { 'checkout-v2': true },
      context: { kind: 'user', key: 'u_7', plan: 'pro' },
    })

    expect(client.getContext()).toMatchObject({ key: 'u_7', plan: 'pro' })
  })
})
