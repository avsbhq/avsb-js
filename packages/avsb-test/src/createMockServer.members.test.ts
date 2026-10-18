/**
 * The AvsbServer members the mock gained for N1-10 (production QA
 * 2026-10-01), each driven the way a request handler under test would call
 * it. Surface parity with the real class is in createMockServer.surface.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockServer } from './createMockServer'
import { createTestDatafile } from './fixtures/datafile'

const ALICE = { kind: 'user', key: 'alice' }
const BOB = { kind: 'user', key: 'bob' }

describe('createMockServer: identity and decisions', () => {
  it('alias records one avsb_alias event attributed to the new context', () => {
    const server = createMockServer()
    server.alias({ kind: 'user', key: 'anon_1' }, ALICE)

    expect(server._tracked()).toEqual([{ eventKey: 'avsb_alias', payload: undefined, contextKey: 'alice' }])
  })

  it('a per-user override beats a global one, for that user only', () => {
    const server = createMockServer({ flags: { cta_copy: 'Buy' } })
    server.setGlobalOverride('cta_copy', 'treatment')
    server.setOverrideForUser('cta_copy', 'alice', 'control')

    expect(server.getFlag('cta_copy', '', ALICE).variationKey).toBe('control')
    expect(server.getFlag('cta_copy', '', BOB).variationKey).toBe('treatment')
    expect(server.getFlag('cta_copy', '', BOB).source).toBe('runtimeOverride')
  })

  it('clearing overrides restores the fixture value', () => {
    const server = createMockServer({ flags: { cta_copy: 'Buy' } })
    server.setGlobalOverride('cta_copy', 'treatment')
    server.setOverrideForUser('cta_copy', 'alice', 'control')

    server.clearOverrideForUser('cta_copy', 'alice')
    expect(server.getFlag('cta_copy', '', ALICE).variationKey).toBe('treatment')

    server.clearAllOverrides()
    const flag = server.getStringFlag('cta_copy', '', ALICE)
    expect(flag.value).toBe('Buy')
    expect(flag.source).toBe('rule')
  })

  it('a forced decision serves the forced variation, not the normal value', () => {
    const server = createMockServer({ flags: { cta_copy: 'Buy' } })
    const bound = server.forUser(ALICE)
    bound.setForcedDecision('cta_copy', { variationKey: 'Buy now' })

    const flag = bound.getStringFlag('cta_copy', '')
    expect(flag.value).toBe('Buy now')
    expect(flag.variationKey).toBe('Buy now')
    expect(flag.source).toBe('runtimeOverride')
  })

  it('createDecisionLog hands out an empty log', () => {
    expect(createMockServer().createDecisionLog()).toEqual({ entries: [] })
  })
})

describe('createMockServer: events and datafile lifecycle', () => {
  it('on() hears evaluations and off() stops it', () => {
    const server = createMockServer({ flags: { checkout_v2: true } })
    const seen = vi.fn()
    server.on('evaluation', seen)

    server.getBoolFlag('checkout_v2', false, ALICE)
    server.off('evaluation', seen)
    server.getBoolFlag('checkout_v2', false, ALICE)

    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen.mock.calls[0][0]).toMatchObject({ flagKey: 'checkout_v2', contextKeys: ['alice'] })
  })

  it('fires ready when it becomes ready, and survives a throwing listener', async () => {
    const server = createMockServer({ ready: false })
    const ready = vi.fn()
    server.on('ready', () => {
      throw new Error('listener bug')
    })
    server.on('ready', ready)

    server._markReady()

    await expect(server.onReady()).resolves.toEqual({ success: true, source: 'network' })
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('refreshDatafile counts the call and announces a config update', async () => {
    const server = createMockServer()
    const updates = vi.fn()
    server.on('configUpdate', updates)

    await server.refreshDatafile()
    await server.refreshDatafile()

    expect(server._refreshCount()).toBe(2)
    expect(updates).toHaveBeenCalledTimes(2)
  })

  it('applyDatafileBootstrap makes a not-ready mock answer from the datafile', () => {
    const server = createMockServer({ ready: false })
    const datafile = createTestDatafile({ checkout_v2: true })

    server.applyDatafileBootstrap(datafile)

    expect(server.isReady()).toBe(true)
    expect(server.getDatafile()).toBe(datafile)
    expect(server.getBoolFlag('checkout_v2', false, ALICE).value).toBe(true)
  })
})

describe('createMockServer: datasets, recs and utils', () => {
  it('datasets.get answers from the fixture and reports misses like the real client', async () => {
    const server = createMockServer({ datasets: { prices: { sku_1: { amount: 1999 } } } })

    await expect(server.datasets.get('prices', 'sku_1')).resolves.toEqual({
      found: true,
      value: { amount: 1999 },
      meta: { slug: 'prices', version: 1 },
    })
    await expect(server.datasets.get('prices', 'sku_9')).resolves.toMatchObject({ found: false })
    await expect(server.datasets.get('unknown', 'k')).resolves.toEqual({
      found: false,
      meta: { slug: 'unknown', version: null },
    })
  })

  it('recs.get serves the fixture products and trackClick is recorded', async () => {
    const server = createMockServer({ recs: { similar: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] } })

    const result = await server.recs.get({ recipe: 'similar', maxItems: 2 })
    expect(result.items.map((item) => item.id)).toEqual(['p1', 'p2'])
    expect(result.served).toBe(true)
    expect((await server.recs.get({ recipe: 'none' })).served).toBe(false)

    server.recs.trackClick('p1', { visitorId: 'alice', experimentId: 'e', variationId: 'v', recipe: 'similar' })
    expect(server._recClicks()).toEqual([{ productId: 'p1', recipe: 'similar', visitorId: 'alice' }])
  })

  it('utils.snapshot(context) captures the mock values for that context', () => {
    const server = createMockServer({ flags: { checkout_v2: true, theme: 'dark' } })

    const snapshot = server.utils.snapshot(ALICE)

    expect(snapshot.flags['checkout_v2']?.value).toBe(true)
    expect(snapshot.flags['theme']?.value).toBe('dark')
  })
})
