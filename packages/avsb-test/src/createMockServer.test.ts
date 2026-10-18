import { describe, expect, it } from 'vitest'
import { TestData } from './TestData'
import { createMockServer } from './createMockServer'
import { flagsFromTestData } from './mockFlags'

function serverWithFixture() {
  return createMockServer(
    flagsFromTestData([
      TestData.flag('checkout-v2')
        .booleanFlag()
        .variationForUser('u_paying', true)
        .fallthroughVariation(false)
        .build(),
      TestData.flag('theme').stringFlag().fallthroughVariation('light').build(),
    ])
  )
}

describe('createMockServer', () => {
  it('evaluates with the context passed positionally, like AvsbServer', () => {
    const server = serverWithFixture()

    expect(
      server.getBoolFlag('checkout-v2', false, { kind: 'user', key: 'u_paying' }).value
    ).toBe(true)
    expect(
      server.getBoolFlag('checkout-v2', false, { kind: 'user', key: 'u_other' }).value
    ).toBe(false)
  })

  it('returns a not_ready flag when no context is passed', () => {
    const flag = serverWithFixture().getFlag('checkout-v2', false)
    expect(flag.source).toBe('not_ready')
    expect(flag.value).toBe(false)
    expect(flag.reasons[0]).toContain('forUser')
  })

  it('returns not_found for a key the fixture does not declare', () => {
    const flag = serverWithFixture().getFlag('unknown-flag', 'fallback', {
      kind: 'user',
      key: 'u_1',
    })
    expect(flag.source).toBe('not_found')
    expect(flag.value).toBe('fallback')
    expect(flag.exists()).toBe(false)
  })

  it('is not ready until _markReady when constructed with ready: false', async () => {
    const server = createMockServer({ flags: { 'checkout-v2': true }, ready: false })

    expect(server.isReady()).toBe(false)
    expect(
      server.getBoolFlag('checkout-v2', false, { kind: 'user', key: 'u_1' }).source
    ).toBe('not_ready')

    server._markReady()

    expect(server.isReady()).toBe(true)
    expect(
      server.getBoolFlag('checkout-v2', false, { kind: 'user', key: 'u_1' }).value
    ).toBe(true)
    await expect(server.onReady()).resolves.toEqual({
      success: true,
      source: 'network',
    })
  })
})

describe('createMockServer.forUser', () => {
  it('binds the context for every read', () => {
    const bound = serverWithFixture().forUser({ kind: 'user', key: 'u_paying' })

    expect(bound.getBoolFlag('checkout-v2', false).value).toBe(true)
    expect(bound.getStringFlag('theme', 'dark').value).toBe('light')
    expect(bound.getContext()).toEqual({ kind: 'user', key: 'u_paying' })
  })

  it('records tracked events against the bound context', () => {
    const server = serverWithFixture()
    server.forUser({ kind: 'user', key: 'u_paying' }).track('purchase', { revenue: 99 })

    expect(server._tracked()).toEqual([
      {
        eventKey: 'purchase',
        payload: { revenue: 99 },
        contextKey: 'u_paying',
      },
    ])
  })

  it('records purchases against the bound context key', async () => {
    const server = serverWithFixture()
    await server
      .forUser({ kind: 'user', key: 'u_paying' })
      .trackPurchase({ orderId: 'o_1', total: 25 })

    expect(server._purchases()).toEqual([
      { visitorId: 'u_paying', order: { orderId: 'o_1', total: 25 } },
    ])
  })

  it('collects a decision log per bound client, not per server', () => {
    const server = serverWithFixture()
    const a = server.forUser({ kind: 'user', key: 'u_paying' })
    const b = server.forUser({ kind: 'user', key: 'u_other' })

    a.getBoolFlag('checkout-v2', false)

    expect(a.getDecisionLog().entries).toHaveLength(1)
    expect(a.getDecisionLog().entries[0].flagKey).toBe('checkout-v2')
    expect(b.getDecisionLog().entries).toHaveLength(0)
  })

  it('honours a forced decision for this request only', () => {
    const server = serverWithFixture()
    const bound = server.forUser({ kind: 'user', key: 'u_other' })

    expect(bound.getBoolFlag('checkout-v2', false).value).toBe(false)

    bound.setForcedDecision('checkout-v2', { variationKey: 'on' })
    expect(bound.getBoolFlag('checkout-v2', false).source).toBe('runtimeOverride')

    bound.clearForcedDecision('checkout-v2')
    expect(bound.getBoolFlag('checkout-v2', false).source).toBe('rule')
    // The shared server state was never touched.
    expect(
      server.getBoolFlag('checkout-v2', false, { kind: 'user', key: 'u_other' }).source
    ).toBe('rule')
  })

  it('lists every answerable flag through getAllFlags', () => {
    const flags = serverWithFixture()
      .forUser({ kind: 'user', key: 'u_paying' })
      .getAllFlags()

    expect(Object.keys(flags).sort()).toEqual(['checkout-v2', 'theme'])
    expect(flags['checkout-v2'].value).toBe(true)
  })
})

describe('createMockServer inspection helpers', () => {
  it('records evaluations with the context they used', () => {
    const server = serverWithFixture()
    server.getBoolFlag('checkout-v2', false, { kind: 'user', key: 'u_paying' })

    expect(server._evaluations()).toEqual([
      { flagKey: 'checkout-v2', value: true, contextKey: 'u_paying' },
    ])
  })

  it('separates manual exposures from evaluated ones', () => {
    const server = serverWithFixture()
    server.getBoolFlag('checkout-v2', false, { kind: 'user', key: 'u_paying' })
    server.manualExposure('checkout-v2', { kind: 'user', key: 'u_paying' })

    expect(server._exposures()).toEqual([
      { flagKey: 'checkout-v2', contextKey: 'u_paying', manual: false },
      { flagKey: 'checkout-v2', contextKey: 'u_paying', manual: true },
    ])
  })

  it('_setFlag changes what later reads answer', () => {
    const server = serverWithFixture()
    server._setFlag('theme', 'midnight')

    expect(
      server.getStringFlag('theme', 'light', { kind: 'user', key: 'u_1' }).value
    ).toBe('midnight')
  })

  it('track from the server itself carries the context in the payload', () => {
    const server = serverWithFixture()
    server.track('signup', { context: { kind: 'user', key: 'u_1' }, value: 1 })

    expect(server._tracked()[0].contextKey).toBe('u_1')
  })
})
