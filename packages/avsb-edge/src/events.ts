// =====================================================================
// Edge event queue and wire bodies (breaking change B7).
//
// WHAT THIS REPLACES: `buildCollectPayload` posted
// `{sdkKey, events: [{eventKey, context, value, properties, timestamp}]}`
// to the bare `collectEndpoint` with no `/v1/collect/*` path and no
// eventIds (report 02 §5.2, old core.ts:110-126). Nothing in the platform
// speaks that shape: the ingestion worker rejects it, so every event an
// edge worker ever sent was thrown away. That payload is deleted.
//
// The bodies below are the locked wire schema
// (packages/avsb-conformance/fixtures/wire/manifest.json), byte-compatible
// with what the browser and node trackers send:
//
//   POST {collect}/v1/collect/batch
//     { sdkKey, events: [{ eventId, visitorId, experimentId, variationId,
//                          eventName, revenue, timestamp, pageUrl,
//                          value?, properties?, attributes? }] }
//
//   POST {collect}/v1/collect/metric-batch
//     { sdkKey, metricEvents: [{ eventId, visitorId, eventName, revenue,
//                                timestamp, pageUrl, value? }] }
//
//   POST {heartbeatEndpoint}
//     { sdkKey, sdkType, sdkVersion }
//
// eventId is REQUIRED, not optional. It is stamped once when the event is
// queued and the serialised body is built ONCE, so a retry re-sends the
// identical bytes and ingestion deduplicates instead of double-counting.
// A tracker that minted ids per attempt would turn every retry into
// inflated exposure counts, which is worse than losing the batch.
//
// EDGE-SPECIFIC POSTURE: an edge invocation ends with its request. There is
// no next flush, no background timer, no process that outlives the response.
// So a failed batch is LOST, and the failure log says exactly that instead
// of promising a retry that can never happen. The one retry inside the
// request is what `waitUntil` buys us on the runtimes that have it.
// =====================================================================

import { collectUrl } from '@avsbhq/core'
import type { ExposureEvent, Logger, MetricEvent } from '@avsbhq/core'
import { fetchWithTimeout } from './net'
import { eventQueueFullMessage, eventSendFailureMessage } from './messages'
import type { EdgeErrorSource } from './types'
import { SDK_TYPE, SDK_VERSION } from './version'

/** The client's `onError`, narrowed to the sources this module produces. */
export type EdgeErrorNotifier = (error: Error, source: EdgeErrorSource) => void

/** Ingestion accepts at most 100 items per batch (wire manifest). */
export const MAX_BATCH_ITEMS = 100

const DEFAULT_MAX_QUEUE_SIZE = 500
const DEFAULT_SEND_TIMEOUT_MS = 5_000
const DEFAULT_RETRY_ATTEMPTS = 1
const DEFAULT_RETRY_DELAY_MS = 200

/**
 * `value` is declared optional on both batch items by the locked wire
 * fixture. `MetricEvent` in @avsbhq/core declares it too, as the SECOND
 * numeric column beside `revenue`, and `AvsbEdgeClient.track` now fills both
 * (breaking change B36). This intersection therefore only adds the field to
 * the EXPOSURE side, which core still leaves out, and it is nullable so the
 * explicit `null` a count event sends survives the intersection with
 * `MetricEvent`.
 */
interface WireValue {
  value?: number | null
}

/** An event on its way to the wire always carries its id. */
export type StampedExposureEvent = ExposureEvent & WireValue & { eventId: string }
export type StampedMetricEvent = MetricEvent & WireValue & { eventId: string }

/**
 * UUID v4 for event deduplication. `crypto.randomUUID` exists on all seven
 * supported runtimes; the fallback covers a runtime that exposes `crypto`
 * without it and keeps this module free of a Node import.
 */
export function generateEventId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// ---------------------------------------------------------------------
// Wire bodies. Field-for-field against the wire fixture; every property is
// written explicitly rather than spread, so an extra field on an internal
// event object can never leak onto the wire and a missing required field is
// a compile error rather than a silent server-side rejection.
// ---------------------------------------------------------------------

export interface ExposureBatchBody {
  sdkKey: string
  events: StampedExposureEvent[]
}

export interface MetricBatchBody {
  sdkKey: string
  metricEvents: StampedMetricEvent[]
}

export interface HeartbeatBody {
  sdkKey: string
  sdkType: string
  sdkVersion: string
}

export function buildExposureBatchBody(
  sdkKey: string,
  events: StampedExposureEvent[],
): ExposureBatchBody {
  return {
    sdkKey,
    events: events.map((e) => ({
      eventId: e.eventId,
      visitorId: e.visitorId,
      experimentId: e.experimentId,
      variationId: e.variationId,
      eventName: e.eventName,
      revenue: e.revenue,
      timestamp: e.timestamp,
      pageUrl: e.pageUrl,
      ...(e.value === undefined ? {} : { value: e.value }),
      ...(e.properties === undefined ? {} : { properties: e.properties }),
      ...(e.attributes === undefined ? {} : { attributes: e.attributes }),
    })),
  }
}

export function buildMetricBatchBody(
  sdkKey: string,
  metricEvents: StampedMetricEvent[],
): MetricBatchBody {
  return {
    sdkKey,
    metricEvents: metricEvents.map((e) => ({
      eventId: e.eventId,
      visitorId: e.visitorId,
      eventName: e.eventName,
      revenue: e.revenue,
      timestamp: e.timestamp,
      pageUrl: e.pageUrl,
      // `properties` is deliberately NOT forwarded: the metric batch has no
      // properties field, so the ingestion worker strips it. The client
      // warns the caller instead of shipping something that looks delivered
      // and is gone (see trackPropertiesDroppedMessage).
      ...(e.value === undefined ? {} : { value: e.value }),
    })),
  }
}

export function buildHeartbeatBody(sdkKey: string): HeartbeatBody {
  return { sdkKey, sdkType: SDK_TYPE, sdkVersion: SDK_VERSION }
}

/** Budget for the liveness POST. Short: it must never delay a response. */
const HEARTBEAT_TIMEOUT_MS = 2_000

/**
 * Report SDK liveness, which is what drives Connected, Stale, and Not
 * connected on the Environments page.
 *
 * `endpoint` comes from the datafile and is never guessed: a heartbeat posted
 * to the wrong host reports liveness nowhere while looking healthy. Failure
 * is logged at debug, not warn, because a missed heartbeat affects a
 * dashboard badge and nothing a visitor sees.
 */
export function sendHeartbeat(
  endpoint: string,
  sdkKey: string,
  logger: Logger,
  onError?: EdgeErrorNotifier,
): Promise<void> {
  return fetchWithTimeout(endpoint, {
    timeoutMs: HEARTBEAT_TIMEOUT_MS,
    what: 'reporting SDK liveness',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildHeartbeatBody(sdkKey)),
    },
  }).then(
    () => undefined,
    (e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e))
      logger.debug('heartbeat send failed', { error: err.message })
      onError?.(err, 'heartbeat')
    },
  )
}

// ---------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------

export interface EdgeEventQueueOptions {
  sdkKey: string
  /**
   * Resolves the datafile's `collectEndpoint`, and is called at FLUSH time,
   * not when the queue is built.
   *
   * That timing matters: a hand-built client can `track()` before `init()`
   * finishes, and resolving then would pin the public ingest default for the
   * whole request even though the datafile that arrived a moment later
   * publishes a self-hosted origin. Every event would go to the wrong host.
   *
   * Origin or full collect URL both work: `collectUrl` normalises it, so
   * `/v1/collect/batch/v1/collect/batch` is not constructible. Undefined or
   * empty falls back to the public ingest host from the endpoint contract,
   * so a bootstrap datafile published before the field existed still
   * delivers events.
   */
  collectEndpoint?: () => string | undefined
  logger: Logger
  /**
   * Notified when a batch is lost. The queue logs its own warning line, so
   * this is the callback seam only: it exists so `onError` on the client
   * fires for the `'events'` source its type declares.
   */
  onError?: EdgeErrorNotifier
  /** Max events per queue in one request. Default 500. */
  maxQueueSize?: number
  /** Ms budget per send. Default 5000. */
  timeoutMs?: number
  /** Retries per failed batch. Default 1. Set 0 to send exactly once. */
  retryAttempts?: number
  /** Ms between retries. Default 200. */
  retryDelayMs?: number
}

export interface EdgeEventQueue {
  queueExposure(event: ExposureEvent & WireValue): StampedExposureEvent
  queueMetric(event: MetricEvent & WireValue): StampedMetricEvent
  /** POST everything queued. Resolves once every batch has been attempted. */
  flush(): Promise<void>
  size(): { events: number; metricEvents: number }
  /** Resolved endpoints, so tests and logs can name the exact target. */
  endpoints(): { batch: string; metricBatch: string }
}

type SendOutcome = { ok: true } | { ok: false; detail: string }

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function createEdgeEventQueue(options: EdgeEventQueueOptions): EdgeEventQueue {
  const { sdkKey, logger } = options
  const maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE)
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
  const retryAttempts = Math.max(0, options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS)
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)

  // Resolved per call, never memoised: see `collectEndpoint` above.
  const resolveEndpoints = (): { batch: string; metricBatch: string } => {
    const endpoint = options.collectEndpoint?.() || undefined
    return {
      batch: collectUrl('batch', endpoint),
      metricBatch: collectUrl('metricBatch', endpoint),
    }
  }

  let exposures: StampedExposureEvent[] = []
  let metrics: StampedMetricEvent[] = []

  function bound(queue: unknown[], label: string): void {
    if (queue.length <= maxQueueSize) return
    queue.splice(0, queue.length - maxQueueSize)
    logger.warn(eventQueueFullMessage(maxQueueSize, label))
  }

  async function post(endpoint: string, body: string): Promise<SendOutcome> {
    try {
      const response = await fetchWithTimeout(endpoint, {
        timeoutMs,
        what: 'sending events',
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        },
      })
      if (response.ok) return { ok: true }
      return { ok: false, detail: `HTTP ${response.status ?? 'unknown'}` }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Send one batch. The body is serialised ONCE before the retry loop, so
   * every attempt carries byte-identical eventIds and ingestion can
   * deduplicate a batch the network made us send twice.
   */
  async function send(endpoint: string, label: string, body: string, count: number): Promise<void> {
    let last: SendOutcome = { ok: false, detail: 'not attempted' }
    const totalAttempts = retryAttempts + 1

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      last = await post(endpoint, body)
      if (last.ok) {
        logger.debug('flushed events', { endpoint, count })
        return
      }
      if (attempt < totalAttempts - 1 && retryDelayMs > 0) await sleep(retryDelayMs)
    }

    const failure = new Error(
      eventSendFailureMessage(count, label, endpoint, totalAttempts, last.detail),
    )
    logger.warn(failure.message)
    options.onError?.(failure, 'events')
  }

  return {
    queueExposure(event: ExposureEvent & WireValue): StampedExposureEvent {
      // An id the caller already assigned is KEPT rather than overwritten:
      // one exposure has one id everywhere it is reported, so a customer's
      // own analytics row and our ingestion row reconcile.
      const stamped: StampedExposureEvent = {
        ...event,
        eventId: event.eventId ?? generateEventId(),
      }
      exposures.push(stamped)
      bound(exposures, 'exposure events')
      return stamped
    },

    queueMetric(event: MetricEvent & WireValue): StampedMetricEvent {
      const stamped: StampedMetricEvent = {
        ...event,
        eventId: event.eventId ?? generateEventId(),
      }
      metrics.push(stamped)
      bound(metrics, 'tracked events')
      return stamped
    },

    async flush(): Promise<void> {
      if (exposures.length === 0 && metrics.length === 0) return

      // Snapshot and clear before sending so an exposure fired from inside a
      // handler that runs during the flush is not sent twice.
      const pendingExposures = exposures
      const pendingMetrics = metrics
      exposures = []
      metrics = []

      const { batch: batchEndpoint, metricBatch: metricEndpoint } = resolveEndpoints()

      const sends: Array<Promise<void>> = []
      for (const part of chunk(pendingExposures, MAX_BATCH_ITEMS)) {
        sends.push(
          send(
            batchEndpoint,
            'exposure events',
            JSON.stringify(buildExposureBatchBody(sdkKey, part)),
            part.length,
          ),
        )
      }
      for (const part of chunk(pendingMetrics, MAX_BATCH_ITEMS)) {
        sends.push(
          send(
            metricEndpoint,
            'tracked events',
            JSON.stringify(buildMetricBatchBody(sdkKey, part)),
            part.length,
          ),
        )
      }

      await Promise.all(sends)
    },

    size(): { events: number; metricEvents: number } {
      return { events: exposures.length, metricEvents: metrics.length }
    },

    endpoints(): { batch: string; metricBatch: string } {
      return resolveEndpoints()
    },
  }
}
