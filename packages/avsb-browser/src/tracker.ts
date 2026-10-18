// =====================================================================
// Browser event tracker (WS2 item 4, report 02 §5.9).
//
// THE BUG THIS EXISTS TO KILL: `flush()` dequeued both buffers BEFORE
// sending and `sendBatch` swallowed every fetch error, so one failed
// flush silently and permanently destroyed those events. No retry, no
// re-enqueue, no log, in the SDK that runs on flaky consumer networks,
// while the node tracker retried with backoff. Exposure data loss where
// it is most likely to happen.
//
// What it does now:
//
//   retry        each send gets `retryAttempts` retries on the shared
//                backoff curve, honouring Retry-After.
//   re-enqueue   a batch that still fails goes back to the FRONT of its
//                queue so the next flush tries again, and the failure is
//                logged with the endpoint, the status, and the count.
//   bound        each queue is capped (`maxQueueSize`); past the cap the
//                OLDEST events are dropped with one warning, so a browser
//                that is offline for an hour cannot grow memory forever.
//   flush backoff  consecutive flush failures push the automatic flush
//                timer up the same curve, so a dead ingest endpoint is not
//                hit every 2 seconds by every open tab.
//   beacon       `navigator.sendBeacon` is used for the page-teardown
//                paths (tab hidden, destroy) where a retry could not
//                finish anyway, and plain fetch elsewhere so failures are
//                observable and retryable. Before, beacon was tried first
//                on every flush, which is exactly why failures were
//                invisible.
// =====================================================================

import type { ExposureEvent, MetricEvent, Tracker } from './types'
import type { Logger } from '@avsbhq/core'
import { noopLogger, collectUrl } from '@avsbhq/core'
import { nextBackoff, parseRetryAfter, resetBackoff, type BackoffState } from './backoff'
import { fetchWithTimeout, hostOf } from './net'

const DEFAULT_FLUSH_INTERVAL_MS = 2000
const DEFAULT_BATCH_SIZE = 10
const DEFAULT_MAX_QUEUE_SIZE = 500
const DEFAULT_RETRY_ATTEMPTS = 3
const SEND_TIMEOUT_MS = 10_000

export interface TrackerOptions {
  /** Ms between automatic flushes. Default 2000. */
  flushInterval?: number
  /** Max events per request. Default 10. */
  batchSize?: number
  /** Max events per queue. Oldest dropped past it. Default 500. */
  maxQueueSize?: number
  /** Retry attempts per failed send. Default 3. */
  retryAttempts?: number
  logger?: Logger
}

/**
 * Generate a UUID v4 for event deduplication.
 * Uses `crypto.randomUUID()` when available (all modern browsers and Node ≥ 14.17).
 * Falls back to a Math.random-based implementation for environments that lack
 * the Web Crypto API (very old browsers, some SSR contexts).
 */
export function generateEventId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }
  // Fallback: RFC 4122 v4 UUID via Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

type SendResult =
  | { ok: true }
  | { ok: false; status: number | null; retryAfterMs: number | null; detail: string }

/**
 * @param onEvent  Kept in argument position 3 on purpose, and nothing in this
 *   package passes it: the analytics-integration pin in
 *   ./integrations.test.ts asserts that the client builds its tracker with
 *   `undefined` in this position, so re-adding a subscriber to our own
 *   outbound event queue has to change that assertion first. `options` sits
 *   after it rather than in its place for the same reason.
 */
export function createTracker(
  sdkKey: string,
  collectEndpoint: string,
  onEvent?: (event: ExposureEvent) => void,
  options: TrackerOptions = {},
): Tracker {
  const flushIntervalMs = options.flushInterval ?? DEFAULT_FLUSH_INTERVAL_MS
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE)
  const maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE)
  const retryAttempts = Math.max(0, options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS)
  const logger = options.logger ?? noopLogger

  // Endpoints come from the core endpoint contract (spec §1.1), so a
  // datafile that publishes either an origin or a full collect URL lands on
  // the same paths and no string surgery happens here.
  const batchEndpoint = collectUrl('batch', collectEndpoint)
  const metricEndpoint = collectUrl('metricBatch', collectEndpoint)

  let events: ExposureEvent[] = []
  let metricEvents: MetricEvent[] = []
  let flushTimerId: ReturnType<typeof setTimeout> | null = null
  let visibilityHandler: (() => void) | null = null
  let destroyed = false
  /** The flush currently sending, so callers chain instead of racing. */
  let inFlight: Promise<void> | null = null
  let flushBackoff: BackoffState | null = resetBackoff()

  function bound(queue: unknown[], label: string): void {
    if (queue.length <= maxQueueSize) return
    const dropped = queue.length - maxQueueSize
    queue.splice(0, dropped)
    logger.warn(
      `AvsB dropped ${dropped} ${label} because the send queue is full ` +
        `(cap ${maxQueueSize}). The oldest events go first. This means events are not ` +
        `reaching ${hostOf(batchEndpoint)}: check the browser network tab for blocked ` +
        'requests, and note that an ad blocker or a Content Security Policy without ' +
        `connect-src ${hostOf(batchEndpoint)} will do this.`,
    )
  }

  async function post(
    endpoint: string,
    body: string,
    useBeacon: boolean,
  ): Promise<SendResult> {
    if (useBeacon) {
      const hasSendBeacon =
        typeof navigator !== 'undefined' &&
        typeof navigator.sendBeacon === 'function'
      if (hasSendBeacon && navigator.sendBeacon(endpoint, body)) {
        // Beacon queued by the browser. Delivery is no longer observable,
        // which is the trade for surviving the unload.
        return { ok: true }
      }
    }

    try {
      const response = await fetchWithTimeout(endpoint, {
        timeoutMs: SEND_TIMEOUT_MS,
        what: 'sending events',
        init: {
          method: 'POST',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body,
        },
      })
      if (response.ok) return { ok: true }
      return {
        ok: false,
        status: response.status ?? null,
        retryAfterMs: parseRetryAfter(
          typeof response.headers?.get === 'function'
            ? response.headers.get('retry-after')
            : null,
        ),
        detail: `HTTP ${response.status ?? 'unknown'}`,
      }
    } catch (e) {
      return {
        ok: false,
        status: null,
        retryAfterMs: null,
        detail: e instanceof Error ? e.message : String(e),
      }
    }
  }

  /**
   * Send one batch, retrying on the backoff curve. Returns true when the
   * batch is delivered; false means the caller must put it back.
   */
  async function sendBatch(
    endpoint: string,
    key: 'events' | 'metricEvents',
    payload: Array<ExposureEvent | MetricEvent>,
    useBeacon: boolean,
  ): Promise<boolean> {
    if (payload.length === 0) return true
    // Serialised once from the already-stamped snapshot, so every retry
    // sends the exact same eventIds and ingestion can deduplicate.
    const body = JSON.stringify({ sdkKey, [key]: payload })

    let backoff: BackoffState | null = resetBackoff()
    let last: SendResult = { ok: false, status: null, retryAfterMs: null, detail: 'not attempted' }

    for (let attempt = 0; attempt <= (useBeacon ? 0 : retryAttempts); attempt++) {
      last = await post(endpoint, body, useBeacon)
      if (last.ok) {
        logger.debug('flushed events', { endpoint, count: payload.length })
        return true
      }
      if (destroyed) break
      if (attempt < retryAttempts && !useBeacon) {
        backoff = nextBackoff(backoff, last.retryAfterMs ?? undefined)
        await sleep(backoff.delayMs)
      }
    }

    if (!last.ok) {
      logger.warn(
        `AvsB could not send ${payload.length} ${key} to ${endpoint} after ` +
          `${useBeacon ? 1 : retryAttempts + 1} attempts (${last.detail}). They are ` +
          'queued and retried on the next flush; nothing is lost unless the queue ' +
          `fills (cap ${maxQueueSize}).`,
      )
    }
    return false
  }

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  function chunk<T>(items: T[]): T[][] {
    const out: T[][] = []
    for (let i = 0; i < items.length; i += batchSize) {
      out.push(items.slice(i, i + batchSize))
    }
    return out
  }

  /**
   * Public flush entry point.
   *
   * When a flush is already in flight this CHAINS behind it rather than
   * returning early, so `await client.flush()` still means "everything that
   * was queued when I called has been attempted". Returning early would make
   * a pre-unload flush silently skip whatever arrived during the previous
   * send.
   */
  function flushInternal(useBeacon: boolean): Promise<void> {
    const previous = inFlight
    if (previous) return previous.then(() => runFlush(useBeacon), () => runFlush(useBeacon))
    return runFlush(useBeacon)
  }

  function runFlush(useBeacon: boolean): Promise<void> {
    if (events.length === 0 && metricEvents.length === 0) {
      // Nothing to send, but the timer chain must keep going or automatic
      // flushing stops for the rest of the session after the first idle tick.
      if (!useBeacon) scheduleFlush()
      return Promise.resolve()
    }
    const promise = performFlush(useBeacon).finally(() => {
      if (inFlight === promise) inFlight = null
    })
    inFlight = promise
    return promise
  }

  async function performFlush(useBeacon: boolean): Promise<void> {
    // Snapshot and clear, then put back exactly what failed. Clearing up
    // front is what makes concurrent enqueues during a slow flush safe;
    // the difference from the old code is that failures come BACK.
    const exposures = events
    const metrics = metricEvents
    events = []
    metricEvents = []

    const failedExposures: ExposureEvent[] = []
    const failedMetrics: MetricEvent[] = []

    try {
      for (const batch of chunk(exposures)) {
        const ok = await sendBatch(batchEndpoint, 'events', batch, useBeacon)
        if (!ok) failedExposures.push(...batch)
      }
      for (const batch of chunk(metrics)) {
        const ok = await sendBatch(metricEndpoint, 'metricEvents', batch, useBeacon)
        if (!ok) failedMetrics.push(...batch)
      }
    } finally {
      if (failedExposures.length > 0) {
        events = [...failedExposures, ...events]
        bound(events, 'exposure events')
      }
      if (failedMetrics.length > 0) {
        metricEvents = [...failedMetrics, ...metricEvents]
        bound(metricEvents, 'tracked events')
      }

      const failed = failedExposures.length + failedMetrics.length
      flushBackoff = failed > 0 ? nextBackoff(flushBackoff) : resetBackoff()
      scheduleFlush()
    }
  }

  function scheduleFlush(): void {
    if (destroyed) return
    if (flushTimerId !== null) {
      clearTimeout(flushTimerId)
      flushTimerId = null
    }
    // A run of failures pushes the timer up the backoff curve instead of
    // retrying every 2s against an endpoint that is clearly not answering.
    const delay = flushBackoff ? Math.max(flushIntervalMs, flushBackoff.delayMs) : flushIntervalMs
    flushTimerId = setTimeout(() => {
      flushTimerId = null
      void flushInternal(false)
    }, delay)
  }

  function queue(event: ExposureEvent): void {
    if (destroyed) return
    // Stamp a stable eventId at enqueue time so retries carry the same id.
    //
    // An id the caller already assigned is KEPT rather than overwritten (D-6
    // Path A): `AvsbClient.handleExposure` mints one id per exposure and hands
    // the same object to this queue, to the event bus, and to third-party
    // forwarding, so a vendor's row and our ingestion row share an id and can
    // be reconciled. Any caller that does not stamp still gets one here, so the
    // guarantee "every event on the wire carries an eventId" is unchanged.
    const stamped: ExposureEvent = {
      ...event,
      eventId: event.eventId ?? generateEventId(),
    }
    events.push(stamped)
    bound(events, 'exposure events')
    if (onEvent) onEvent(stamped)
    if (events.length >= batchSize) void flushInternal(false)
  }

  function queueMetric(event: MetricEvent): void {
    if (destroyed) return
    const stamped: MetricEvent = {
      ...event,
      eventId: event.eventId || generateEventId(),
    }
    metricEvents.push(stamped)
    bound(metricEvents, 'tracked events')
    if (metricEvents.length >= batchSize) void flushInternal(false)
  }

  // Flush on page hide. sendBeacon is preferred here because a retry loop
  // cannot outlive the unload, and a queued beacon survives it.
  if (
    typeof document !== 'undefined' &&
    typeof document.addEventListener === 'function'
  ) {
    visibilityHandler = () => {
      if (document.visibilityState === 'hidden') void flushInternal(true)
    }
    document.addEventListener('visibilitychange', visibilityHandler)
  }

  scheduleFlush()

  async function destroy(): Promise<void> {
    // Marked destroyed FIRST so the final flush cannot schedule another
    // timer behind itself and leave a live interval after teardown.
    destroyed = true
    if (flushTimerId !== null) {
      clearTimeout(flushTimerId)
      flushTimerId = null
    }
    if (visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandler)
      visibilityHandler = null
    }
    // Beacon-preferred: destroy runs on teardown, where waiting out a
    // retry curve is not an option.
    await flushInternal(true)
  }

  return {
    queue,
    queueMetric,
    flush: () => flushInternal(false),
    destroy,
    size: () => ({ events: events.length, metricEvents: metricEvents.length }),
  }
}
