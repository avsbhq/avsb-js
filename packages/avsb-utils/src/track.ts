// Track helpers — trackBatch, trackOnce, Transaction/Item primitives.
// Spec §6.2.
//
// trackOnce uses a Set in the client scope to dedupe by user-supplied key
// across the lifetime of the SDK client.

import type { TrackPayload, Logger } from '@avsbhq/core'
import type { CleanupRegistry } from './registry'

export interface TrackClient {
  track(eventKey: string, payload?: TrackPayload): void
}

export interface Item {
  id: string
  name?: string
  category?: string
  price?: number
  quantity?: number
  metadata?: Record<string, unknown>
}

export interface TransactionInit {
  orderId: string
  revenue: number
  currency: string
  items?: Item[]
  metadata?: Record<string, unknown>
}

export class Transaction {
  readonly orderId: string
  readonly revenue: number
  readonly currency: string
  readonly items: Item[]
  readonly metadata: Record<string, unknown>

  constructor(init: TransactionInit) {
    this.orderId = init.orderId
    this.revenue = init.revenue
    this.currency = init.currency
    this.items = init.items ?? []
    this.metadata = init.metadata ?? {}
  }

  toPayload(): TrackPayload {
    return {
      value: this.revenue,
      properties: {
        orderId: this.orderId,
        currency: this.currency,
        items: this.items,
        ...this.metadata,
      },
    }
  }
}

export function itemOf(init: Item): Item {
  return { ...init }
}

export function createTrack(
  client: TrackClient,
  registry: CleanupRegistry,
  log: Logger
): {
  trackBatch(
    events: Array<{ eventKey: string; payload?: TrackPayload }>
  ): void
  trackOnce(
    eventKey: string,
    dedupKey: string,
    payload?: TrackPayload
  ): void
  trackRevenue(
    eventKey: string,
    amount: number,
    currency: string,
    items?: Item[]
  ): void
  trackTransaction(eventKey: string, tx: Transaction): void
} {
  const seen = new Set<string>()
  registry.add(() => seen.clear())
  return {
    trackBatch(events) {
      for (const ev of events) {
        try {
          client.track(ev.eventKey, ev.payload)
        } catch (e) {
          log.warn('trackBatch entry failed', {
            eventKey: ev.eventKey,
            error: String(e),
          })
        }
      }
    },
    trackOnce(eventKey, dedupKey, payload) {
      const k = `${eventKey}:${dedupKey}`
      if (seen.has(k)) return
      seen.add(k)
      client.track(eventKey, payload)
    },
    trackRevenue(eventKey, amount, currency, items) {
      client.track(eventKey, {
        value: amount,
        properties: { currency, items: items ?? [] },
      })
    },
    trackTransaction(eventKey, tx) {
      client.track(eventKey, tx.toPayload())
    },
  }
}
