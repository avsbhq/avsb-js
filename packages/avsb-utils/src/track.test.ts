import { describe, expect, it, vi } from 'vitest'
import { noopLogger } from '@avsbhq/core'
import { createRegistry } from './registry'
import { Transaction, createTrack, itemOf } from './track'

describe('createTrack.trackBatch', () => {
  it('invokes client.track for every event', () => {
    const client = { track: vi.fn() }
    const t = createTrack(client, createRegistry(), noopLogger)
    t.trackBatch([
      { eventKey: 'a', payload: { value: 1 } },
      { eventKey: 'b' },
    ])
    expect(client.track).toHaveBeenCalledTimes(2)
  })

  it('a throwing track does not stop the rest of the batch', () => {
    let calls = 0
    const client = {
      track: vi.fn(() => {
        calls++
        if (calls === 1) throw new Error('boom')
      }),
    }
    const t = createTrack(client, createRegistry(), noopLogger)
    t.trackBatch([
      { eventKey: 'a' },
      { eventKey: 'b' },
    ])
    expect(client.track).toHaveBeenCalledTimes(2)
  })
})

describe('createTrack.trackOnce', () => {
  it('dedupes by (eventKey, dedupKey) pair', () => {
    const client = { track: vi.fn() }
    const t = createTrack(client, createRegistry(), noopLogger)
    t.trackOnce('signup', 'u_1')
    t.trackOnce('signup', 'u_1')
    t.trackOnce('signup', 'u_2')
    t.trackOnce('login', 'u_1')
    expect(client.track).toHaveBeenCalledTimes(3)
  })

  it('clears its dedup memory when the registry drains', () => {
    const client = { track: vi.fn() }
    const reg = createRegistry()
    const t = createTrack(client, reg, noopLogger)
    t.trackOnce('signup', 'u_1')
    reg.drain()
    t.trackOnce('signup', 'u_1')
    expect(client.track).toHaveBeenCalledTimes(2)
  })
})

describe('Transaction', () => {
  it('toPayload() encodes revenue as value and adds items', () => {
    const tx = new Transaction({
      orderId: 'o_1',
      revenue: 99.5,
      currency: 'USD',
      items: [itemOf({ id: 'i_1', name: 'Book', price: 99.5, quantity: 1 })],
    })
    const p = tx.toPayload()
    expect(p.value).toBe(99.5)
    expect(p.properties?.currency).toBe('USD')
    expect(Array.isArray(p.properties?.items)).toBe(true)
  })

  it('merges caller metadata into properties', () => {
    const tx = new Transaction({
      orderId: 'o_1',
      revenue: 10,
      currency: 'USD',
      metadata: { promoCode: 'SUMMER' },
    })
    expect((tx.toPayload().properties as Record<string, string>).promoCode).toBe(
      'SUMMER'
    )
  })
})

describe('createTrack.trackRevenue + trackTransaction', () => {
  it('trackRevenue sends value + currency + items', () => {
    const client = { track: vi.fn() }
    const t = createTrack(client, createRegistry(), noopLogger)
    t.trackRevenue('purchase', 49.99, 'USD', [
      itemOf({ id: 'i_1', name: 'T' }),
    ])
    expect(client.track).toHaveBeenCalledWith('purchase', {
      value: 49.99,
      properties: {
        currency: 'USD',
        items: [{ id: 'i_1', name: 'T' }],
      },
    })
  })

  it('trackTransaction forwards Transaction.toPayload()', () => {
    const client = { track: vi.fn() }
    const t = createTrack(client, createRegistry(), noopLogger)
    const tx = new Transaction({ orderId: 'o', revenue: 5, currency: 'EUR' })
    t.trackTransaction('purchase', tx)
    expect(client.track).toHaveBeenCalledWith('purchase', tx.toPayload())
  })
})
