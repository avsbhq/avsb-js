import { randomUUID } from 'node:crypto'
import { collectUrl } from '@avsbhq/core'
import type { ExposureEvent, MetricEvent, Logger } from './types'
// One shared retry curve for the whole SDK family (`@avsbhq/utils/backoff`).
// This package used to carry its own copy in reconnectBackoff.ts.
import {
  nextBackoff,
  resetBackoff,
  parseRetryAfter,
  type BackoffState,
} from '@avsbhq/utils/backoff'

/**
 * Purchase order shape for server-side purchase tracking.
 * Mirrors the client-side snippet PurchaseOrder interface.
 * Decimal values are forwarded as-is; no server-side currency conversion.
 */
export interface PurchaseOrder {
  /** Required. Unique order/transaction identifier. */
  orderId: string
  /** Required. Order total as a decimal (e.g. 99.95). */
  total: number
  /** ISO 4217 currency code. */
  currency?: string
  subtotal?: number
  shipping?: number
  tax?: number
  discount?: number
  coupon?: string
  /** Mark this as a test purchase. Test orders are stored but excluded from all
   *  revenue, profit, recommendation, and audience calculations. Only send when
   *  intentionally testing your integration. */
  test?: boolean
  items?: Array<{
    sku: string
    /**
     * Canonical product-grain key (e-commerce suite overhaul, contract C1).
     * Pass when known so order items join catalog/recommendation analytics
     * without alias resolution; the ingestion worker derives it from `sku`
     * otherwise.
     */
    productKey?: string
    name?: string
    price?: number
    quantity?: number
    category?: string
  }>
}

/** Wire payload sent to /v1/collect/orders. */
interface PurchasePayload extends PurchaseOrder {
  eventId: string
  visitorId: string
  timestamp: number
  pageUrl: string
}

// Internal types that assert eventId is present after the enqueue stamp.
// eventId is optional on the shared wire type so that @avsbhq/core's evaluator
// (which constructs ExposureEvent literals) does not need to be modified.
// Everything that enters the queue goes through stampExposure / stampMetric,
// so every event in the internal buffers is guaranteed to have eventId set.
type StampedExposureEvent = ExposureEvent & { eventId: string }
type StampedMetricEvent = MetricEvent & { eventId: string }

function stampExposure(event: ExposureEvent): StampedExposureEvent {
  return event.eventId ? (event as StampedExposureEvent) : { ...event, eventId: randomUUID() }
}

function stampMetric(event: MetricEvent): StampedMetricEvent {
  return event.eventId ? (event as StampedMetricEvent) : { ...event, eventId: randomUUID() }
}

export interface ServerTracker {
  queue(event: ExposureEvent): void
  queueMetric(event: MetricEvent): void
  /**
   * Send a purchase/order event to /v1/collect/orders.
   * Unlike queue/queueMetric, this fires immediately (not batched) using the
   * same retry/backoff logic as regular event flushes.
   * @param visitorId - The visitor/user identifier for attribution.
   * @param order     - The purchase order details.
   */
  trackPurchase(visitorId: string, order: PurchaseOrder): Promise<void>
  flush(): Promise<void>
  destroy(): Promise<void>
}

export interface ServerTrackerOptions {
  sdkKey: string
  collectEndpoint: string
  flushInterval: number
  batchSize: number
  maxQueueSize: number
  retryAttempts: number
  logger: Logger
}

export function createServerTracker(options: ServerTrackerOptions): ServerTracker {
  const {
    sdkKey,
    collectEndpoint,
    flushInterval,
    batchSize,
    maxQueueSize,
    retryAttempts,
    logger,
  } = options

  // Endpoints come from the @avsbhq/core contract (spec §1.1), not from
  // string surgery on whatever the datafile carried. `collectUrl` normalises
  // an origin OR a full collect URL, so a datafile that publishes
  // `https://ingest.avsb.cloud/v1/collect/batch` can never produce
  // `/v1/collect/batch/v1/collect/batch`.
  const batchEndpoint = collectUrl('batch', collectEndpoint)
  const metricEndpoint = collectUrl('metricBatch', collectEndpoint)
  const ordersEndpoint = collectUrl('orders', collectEndpoint)

  // Queues hold stamped events — eventId is guaranteed present on every entry.
  let exposureQueue: StampedExposureEvent[] = []
  let metricQueue: StampedMetricEvent[] = []
  let flushTimer: ReturnType<typeof setInterval> | null = null
  let destroyed = false

  // Start auto-flush timer
  flushTimer = setInterval(() => {
    flush().catch((e) => {
      logger.error('Auto-flush error', { error: String(e) })
    })
  }, flushInterval)

  function queue(event: ExposureEvent): void {
    if (destroyed) return
    // eventId is stamped here, at enqueue time. The same stamped object is
    // serialised on every send attempt, so retried batches carry the same ids.
    exposureQueue.push(stampExposure(event))
    if (exposureQueue.length > maxQueueSize) {
      const dropped = exposureQueue.length - maxQueueSize
      exposureQueue = exposureQueue.slice(-maxQueueSize)
      logger.warn(`Event queue full (${maxQueueSize}), dropping ${dropped} oldest events`)
    }
    if (exposureQueue.length >= batchSize) {
      flush().catch((e) => {
        logger.error('Batch-triggered flush error', { error: String(e) })
      })
    }
  }

  function queueMetric(event: MetricEvent): void {
    if (destroyed) return
    // Same enqueue-time stamp guarantee as queue() above.
    metricQueue.push(stampMetric(event))
    if (metricQueue.length > maxQueueSize) {
      const dropped = metricQueue.length - maxQueueSize
      metricQueue = metricQueue.slice(-maxQueueSize)
      logger.warn(`Metric queue full (${maxQueueSize}), dropping ${dropped} oldest events`)
    }
    if (metricQueue.length >= batchSize) {
      flush().catch((e) => {
        logger.error('Batch-triggered flush error', { error: String(e) })
      })
    }
  }

  async function flush(): Promise<void> {
    if (exposureQueue.length === 0 && metricQueue.length === 0) return

    // Snapshot and reset
    const exposures = exposureQueue
    const metrics = metricQueue
    exposureQueue = []
    metricQueue = []

    const promises: Promise<void>[] = []

    // Split into chunks and send
    for (let i = 0; i < exposures.length; i += batchSize) {
      const chunk = exposures.slice(i, i + batchSize)
      promises.push(sendBatch(batchEndpoint, 'events', chunk))
    }
    for (let i = 0; i < metrics.length; i += batchSize) {
      const chunk = metrics.slice(i, i + batchSize)
      promises.push(sendBatch(metricEndpoint, 'metricEvents', chunk))
    }

    await Promise.all(promises)
  }

  async function sendBatch(
    endpoint: string,
    key: 'events' | 'metricEvents',
    payload: StampedExposureEvent[] | StampedMetricEvent[]
  ): Promise<void> {
    // body is serialised once from the already-stamped snapshot. Every retry
    // loop iteration sends this exact same string — eventIds never change.
    const body = JSON.stringify({ sdkKey, [key]: payload })

    let backoff: BackoffState | null = resetBackoff()
    let pendingRetryAfterMs: number | undefined = undefined
    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) {
          // Honor Retry-After when the worker emits it (429s do; some
          // upstream proxies do too on 503). Falls through to the
          // catch block which schedules the next attempt.
          const parsed = parseRetryAfter(response.headers.get('retry-after'))
          if (parsed !== null) pendingRetryAfterMs = parsed
          throw new Error(`HTTP ${response.status}`)
        }
        logger.debug(`Flushed ${payload.length} events to ${endpoint}`)
        return
      } catch (e) {
        if (attempt < retryAttempts) {
          backoff = nextBackoff(backoff, pendingRetryAfterMs)
          pendingRetryAfterMs = undefined
          await new Promise((r) => setTimeout(r, backoff!.delayMs))
        } else {
          logger.error(
            `Failed to flush ${payload.length} events after ${retryAttempts} retries`,
            { endpoint, error: String(e) }
          )
        }
      }
    }
  }

  async function trackPurchase(visitorId: string, order: PurchaseOrder): Promise<void> {
    if (destroyed) return

    const payload: PurchasePayload = {
      ...order,
      eventId: randomUUID(),
      visitorId,
      timestamp: Date.now(),
      pageUrl: '',
    }

    const body = JSON.stringify({ sdkKey, orders: [payload] })
    let backoff: BackoffState | null = resetBackoff()
    let pendingRetryAfterMs: number | undefined = undefined

    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      try {
        const response = await fetch(ordersEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) {
          const parsed = parseRetryAfter(response.headers.get('retry-after'))
          if (parsed !== null) pendingRetryAfterMs = parsed
          throw new Error(`HTTP ${response.status}`)
        }
        logger.debug(`Purchase order ${order.orderId} sent for visitor ${visitorId}`)
        return
      } catch (e) {
        if (attempt < retryAttempts) {
          backoff = nextBackoff(backoff, pendingRetryAfterMs)
          pendingRetryAfterMs = undefined
          await new Promise((r) => setTimeout(r, backoff!.delayMs))
        } else {
          logger.error(
            `Failed to send purchase order ${order.orderId} after ${retryAttempts} retries`,
            { endpoint: ordersEndpoint, error: String(e) }
          )
        }
      }
    }
  }

  async function destroy(): Promise<void> {
    destroyed = true
    if (flushTimer) {
      clearInterval(flushTimer)
      flushTimer = null
    }
    await flush()
  }

  return { queue, queueMetric, trackPurchase, flush, destroy }
}
