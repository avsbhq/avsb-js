// =====================================================================
// `track()` payload to wire shape.
//
// Two non-obvious rules, both kept honest here:
//
// 1. `revenue` and `value` are TWO columns, not one. `revenue` is money in
//    decimal major units; `value` is the numeric metric value for
//    average-value metrics. The metric_batch wire fixture declares both, and
//    `metric_events` stores both as Nullable(Float64). This mapper used to
//    ship `payload.value` into the revenue column, so a quantity was recorded
//    as money and the value column could never be written at all.
// 2. `payload.properties` is NOT forwarded. The ingestion contract for
//    `/v1/collect/metric-batch` declares no properties field, so anything
//    extra was stripped at the edge and never reached storage. Spreading it
//    onto the event made the SDK look like it recorded something it did not.
//    Exposure events do carry properties; conversions do not.
// =====================================================================

import { getContextByKind, isMultiContext } from '@avsbhq/core'
import type { EvalContext, MetricEvent, SingleContext, TrackPayload } from '@avsbhq/core'

export interface MetricEventInput {
  context: EvalContext
  eventKey: string
  payload?: TrackPayload
}

/**
 * The visitor id events are attributed to: the context key, or the `user`
 * sub-context's key under multi-context.
 *
 * It used to prefer an arbitrary attribute named by `userIdAttribute`, so a
 * context could bucket on one id and report its events under another. One key
 * does both jobs now (breaking change B5).
 */
export function visitorIdOf(ctx: EvalContext): string {
  if (isMultiContext(ctx)) {
    const user = getContextByKind(ctx, 'user')
    return user ? user.key : ''
  }
  return (ctx as SingleContext).key
}

export function toMetricEvent(input: MetricEventInput): MetricEvent {
  const isBrowser =
    typeof window !== 'undefined' && typeof location !== 'undefined'

  return {
    // eventId is intentionally empty here. The tracker stamps a stable UUID
    // at enqueue time (generateEventId in tracker.ts) so that flush retries
    // always resend the same id.
    eventId: '',
    visitorId: visitorIdOf(input.context),
    eventName: input.eventKey,
    revenue: input.payload?.revenue ?? null,
    value: input.payload?.value ?? null,
    timestamp: Date.now(),
    pageUrl: isBrowser ? location.href : '',
  }
}
