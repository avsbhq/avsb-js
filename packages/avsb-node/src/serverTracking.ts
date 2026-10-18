// Event delivery for AvsbServer: metric events, purchases, exposures, the
// tracker itself and the three pre-ready queues it drains. Split out of
// AvsbServer.ts (FU-31); the class keeps the public methods and calls these.

import { randomUUID } from 'node:crypto'
import type { EvalContext, ExposureEvent, TrackPayload } from '@avsbhq/core'
import { bucketingKey } from '@avsbhq/core'
import { createServerTracker } from './serverTracker'
import type { PurchaseOrder } from './serverTracker'
import { emit, warnOnce } from './serverState'
import type { ServerState } from './serverState'
import type { AvsbServer } from './AvsbServer'

/** The body of `AvsbServer.track`. */
export function trackMetric(
  s: ServerState,
  eventKey: string,
  payload: TrackPayload & { context: EvalContext }
): void {
  if (payload.properties) {
    warnOnce(
      s,
      'track-properties',
      `track("${eventKey}") was called with properties, which are NOT stored for ` +
        'metric events: the ingestion contract for a conversion keeps the event ' +
        'name, the numeric value, the timestamp, and the visitor id. Exposure ' +
        'events do carry properties. Nothing else about the call is affected.'
    )
  }

  if (!s.tracker) {
    enqueuePending(s, eventKey, payload)
    return
  }

  s.tracker.queueMetric({
    visitorId: bucketingKey(payload.context),
    eventName: eventKey,
    // TWO columns, not one. `revenue` is money in decimal major units;
    // `value` is the numeric metric value for average-value metrics. Storage
    // declares both (`metric_events.revenue`, `metric_events.value`). This
    // SDK used to ship `payload.value` into the revenue column and could
    // never write the value column at all, so a quantity was recorded as
    // money and every average-value metric read empty.
    revenue: payload.revenue ?? null,
    value: payload.value ?? null,
    timestamp: Date.now(),
    pageUrl: '',
  })
}

/** The body of `AvsbServer.trackPurchase`. */
export async function trackPurchase(
  s: ServerState,
  visitorId: string,
  order: PurchaseOrder
): Promise<void> {
  if (s.destroyed) return
  if (!s.tracker) {
    if (s.pendingPurchases.length >= s.eventOptions.maxQueueSize) {
      s.pendingPurchases.shift()
      warnOnce(
        s,
        'pending-purchase-full',
        `Pre-ready purchase queue reached ${s.eventOptions.maxQueueSize} orders; ` +
          'the oldest is being dropped. This means the datafile never loaded: check ' +
          'the datafile error logged above.'
      )
    }
    s.pendingPurchases.push({ visitorId, order })
    return
  }
  return s.tracker.trackPurchase(visitorId, order)
}

/**
 * One exposure, delivered everywhere: queued for ingestion AND emitted on
 * the event bus with the SAME `eventId`, so a customer forwarding decisions
 * to their own analytics can reconcile rows with A vs B results.
 */
export function deliverExposure(s: ServerState, event: ExposureEvent): void {
  const stamped: ExposureEvent = event.eventId
    ? event
    : { ...event, eventId: randomUUID() }
  if (s.tracker) {
    s.tracker.queue(stamped)
  } else {
    // Hold it rather than drop it. `track` and `trackPurchase` have always
    // buffered when the tracker does not exist yet; exposures were the one
    // member of the family that silently vanished (`this.tracker?.queue()`),
    // and a lost exposure is the worse loss: it removes a visitor from the
    // DENOMINATOR, so the experiment still reports a conversion rate, just a
    // wrong one that nobody can see is wrong.
    enqueuePendingExposure(s, stamped)
  }
  emit(s, 'exposure', stamped)
}

/**
 * Build the tracker once a datafile names the collect endpoint, then drain
 * the pre-ready queues into it. Idempotent. The metric and purchase drains go
 * back through the server's public `track` and `trackPurchase`, as they
 * always have.
 */
export function initTracker(s: ServerState, server: AvsbServer): void {
  if (!s.datafile || s.tracker) return
  const tracker = createServerTracker({
    sdkKey: s.sdkKey,
    collectEndpoint: s.datafile.collectEndpoint,
    flushInterval: s.eventOptions.flushInterval,
    batchSize: s.eventOptions.batchSize,
    maxQueueSize: s.eventOptions.maxQueueSize,
    retryAttempts: s.eventOptions.retryAttempts,
    logger: s.logger,
  })
  s.tracker = tracker

  // Exposures first: they are the decision record the conversions below are
  // measured against. Queued through the local, because `server.track()` in
  // the metric drain re-reads the tracker and would widen the narrowing.
  if (s.pendingExposures.length > 0) {
    const queued = s.pendingExposures
    s.pendingExposures = []
    for (const event of queued) tracker.queue(event)
  }
  if (s.pendingEvents.length > 0) {
    const queued = s.pendingEvents
    s.pendingEvents = []
    for (const item of queued) server.track(item.eventKey, item.payload)
  }
  if (s.pendingPurchases.length > 0) {
    const queued = s.pendingPurchases
    s.pendingPurchases = []
    for (const item of queued) void server.trackPurchase(item.visitorId, item.order)
  }
}

function enqueuePendingExposure(s: ServerState, event: ExposureEvent): void {
  if (s.pendingExposures.length >= s.eventOptions.maxQueueSize) {
    s.pendingExposures.shift()
    warnOnce(
      s,
      'pending-exposures-full',
      `Pre-ready exposure queue reached ${s.eventOptions.maxQueueSize} events; ` +
        'the oldest are being dropped. This means the datafile never loaded, so ' +
        'nothing has been delivered yet: check the datafile error logged above.'
    )
  }
  s.pendingExposures.push(event)
}

function enqueuePending(
  s: ServerState,
  eventKey: string,
  payload: TrackPayload & { context: EvalContext }
): void {
  if (s.pendingEvents.length >= s.eventOptions.maxQueueSize) {
    s.pendingEvents.shift()
    warnOnce(
      s,
      'pending-events-full',
      `Pre-ready event queue reached ${s.eventOptions.maxQueueSize} events; the ` +
        'oldest are being dropped. This means the datafile never loaded, so nothing ' +
        'has been delivered yet: check the datafile error logged above.'
    )
  }
  s.pendingEvents.push({ eventKey, payload })
}
