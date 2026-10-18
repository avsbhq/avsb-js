// Event delivery for AvsbClient: tracked events, exposures, the tracker and
// its pre-ready queue, and the liveness heartbeat. Split out of AvsbClient.ts
// (FU-31).

import type { EvalContext, ExposureEvent, TrackPayload } from '@avsbhq/core'
import { privateAttributesFrom, resolveHeartbeatEndpoint } from '@avsbhq/core'
import { redactExposure } from '@avsbhq/utils/exposure'
import { createTracker, generateEventId } from './tracker'
import { createIntegrationDispatcher } from './integrations'
import { SDK_TYPE, SDK_VERSION } from './version'
import { pendingQueueFullMessage, trackAfterCloseMessage } from './messages'
import { toMetricEvent } from './metricEvent'
import { fetchWithTimeout } from './net'
import { warnOnce } from './clientState'
import type { ClientState } from './clientState'

/** The body of `AvsbClient.track`. */
export function trackEvent(
  s: ClientState,
  eventKey: string,
  payload?: TrackPayload,
): void {
  if (s.closed) {
    warnOnce(s, 'track-after-close', trackAfterCloseMessage(eventKey))
    return
  }

  if (!s.tracker) {
    // Bounded pre-ready queue (report 02 §5.30): a page that never reaches
    // ready used to accumulate events in memory without limit.
    s.pendingEvents.push({ eventKey, payload })
    if (s.pendingEvents.length > s.maxPendingEvents) {
      const dropped = s.pendingEvents.length - s.maxPendingEvents
      s.pendingEvents.splice(0, dropped)
      warnOnce(
        s,
        'pending-queue-full',
        pendingQueueFullMessage(s.maxPendingEvents, dropped),
      )
    }
    return
  }

  s.tracker.queueMetric(
    toMetricEvent({
      context: s.context,
      eventKey,
      payload,
    }),
  )
}

/**
 * The one place an exposure fans out. Our own ingestion queue comes first
 * (it is the product), then the §2.14 `exposure` event, then third-party
 * forwarding when destinations are configured.
 *
 * The `eventId` is minted HERE, once, and the same stamped object goes to all
 * three (D-6 Path A). That is what makes the ids reconcile: a row in the
 * customer's Google Analytics carries the same `event_id` as our own
 * ingestion row for that exposure, and a bus subscriber sees the id both of
 * them will use. Minting separately per destination would have produced three
 * ids for one decision and nothing to join them on.
 */
/**
 * @param evaluatedContext the context the exposure was produced FOR, which
 * is not always the bound one: `getAllFlags({ context, fireExposures: true })`
 * evaluates a caller-supplied context, and its private attributes are the
 * ones that must not leave.
 */
export function handleExposure(
  s: ClientState,
  event: ExposureEvent,
  evaluatedContext: EvalContext
): void {
  // Redact BEFORE the event reaches any consumer. `_meta.privateAttributes`
  // promises these values never leave on an exposure, and `forwardExposure`
  // ships to third-party destinations we do not control, so redacting after
  // any of these three hand-offs would already be too late.
  const privateAttributes = privateAttributesFrom(evaluatedContext)
  const clean = privateAttributes.size
    ? redactExposure(event, [...privateAttributes])
    : event

  const stamped: ExposureEvent =
    clean.eventId === undefined
      ? { ...clean, eventId: generateEventId() }
      : clean
  s.tracker?.queue(stamped)
  s.bus.emit('exposure', stamped)
  s.forwardExposure?.(stamped)
}

export function ensureTracker(s: ClientState): void {
  if (s.tracker || !s.datafile || s.closed) return

  // The tracker still receives NO event callback (integrations spec §8,
  // finding F-2). Third-party forwarding does not hang off the tracker's
  // queue any more: it hangs off `handleExposure` above, gated on config.
  // Keeping argument 3 undefined is the structural half of the OFF pin in
  // ./integrations.test.ts — nothing can subscribe to our own outbound
  // event queue.
  s.tracker = createTracker(s.sdkKey, s.datafile.collectEndpoint, undefined, {
    flushInterval: s.eventOptions.flushInterval,
    batchSize: s.eventOptions.batchSize,
    maxQueueSize: s.eventOptions.maxQueueSize,
    retryAttempts: s.eventOptions.retryAttempts,
    logger: s.logger,
  })

  // Third-party forwarding (D-10). Returns null unless this project's
  // datafile carries an `integrations` block naming a destination this SDK
  // has an adapter for, so an SDK installed without configured destinations
  // never reads, let alone writes, an analytics global.
  //
  // Bound ONCE, to the datafile this session started with: a settings change
  // republished mid-session takes effect on the visitor's next page load,
  // matching the snippet's documented behaviour.
  s.forwardExposure = createIntegrationDispatcher(s.datafile)

  // Flush events queued before the tracker came up.
  if (s.pendingEvents.length > 0) {
    const queued = s.pendingEvents
    s.pendingEvents = []
    for (const { eventKey, payload } of queued) {
      s.tracker.queueMetric(
        toMetricEvent({
          context: s.context,
          eventKey,
          payload,
        }),
      )
    }
  }
}

export function sendHeartbeat(s: ClientState): void {
  const endpoint = resolveHeartbeatEndpoint(s.datafile?.heartbeatEndpoint)
  if (!endpoint) return

  void fetchWithTimeout(endpoint, {
    timeoutMs: s.initTimeoutMs,
    what: 'reporting SDK liveness',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sdkKey: s.sdkKey,
        // The wrapping framework package when there is one (N1-14), so the
        // Environments page names what the customer installed.
        sdkType: s.wrapper?.sdkType ?? SDK_TYPE,
        sdkVersion: s.wrapper?.sdkVersion ?? SDK_VERSION,
      }),
    },
  }).catch((e: unknown) => {
    // Liveness reporting is best effort: it drives a dashboard badge, and
    // failing to send it must never affect flag delivery.
    const err = e instanceof Error ? e : new Error(String(e))
    s.logger.debug('heartbeat send failed', { error: err.message })
  })
}
