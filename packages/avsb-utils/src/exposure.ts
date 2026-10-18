// =====================================================================
// `@avsbhq/utils/exposure` — private-attribute redaction on the way OUT.
//
// THE BUG THIS EXISTS TO KILL. `ContextMeta.privateAttributes` promises that
// the named attribute keys are "redacted from exposure events and decision-log
// reasons" (@avsbhq/core types.ts §2.1). The decision-log half was implemented
// in the node package. The exposure half was not:
//
//   - The server SDK deleted the named keys from `event.properties`, which
//     carries only decision metadata (flagKey, flagId, holdoutId, banditKey).
//     The context's attributes ride `event.attributes`, built by
//     `buildExposureAttributes` in the evaluator, so nothing was ever removed
//     and the values reached /v1/collect/batch and the exposure event bus.
//   - The browser SDK did not redact at all.
//
// One helper, used by both, so the promise holds in every runtime.
//
// Zero dependencies beyond the core type, so this is safe as a leaf subpath in
// a browser bundle.
// =====================================================================

import type { ExposureEvent } from '@avsbhq/core'

/**
 * Strip the context's private attributes from an exposure before it is queued,
 * emitted, or forwarded.
 *
 * `attributes` is the field that matters: it holds the context's registered
 * attribute values, stringified for storage. `properties` is cleaned too, for
 * the case where a future decision property echoes an attribute name; it costs
 * one object copy on a path that already copies.
 *
 * Returns the SAME object when there is nothing to redact, so the common case
 * allocates nothing.
 */
export function redactExposure(
  event: ExposureEvent,
  privateAttributes: readonly string[] | undefined,
): ExposureEvent {
  if (!privateAttributes || privateAttributes.length === 0) return event

  const hasAttribute =
    event.attributes !== undefined &&
    privateAttributes.some((key) => key in event.attributes!)
  const hasProperty =
    event.properties !== undefined &&
    privateAttributes.some((key) => key in event.properties!)

  if (!hasAttribute && !hasProperty) return event

  const next: ExposureEvent = { ...event }

  if (hasAttribute && event.attributes) {
    const attributes = { ...event.attributes }
    for (const key of privateAttributes) delete attributes[key]
    next.attributes = attributes
  }
  if (hasProperty && event.properties) {
    const properties = { ...event.properties }
    for (const key of privateAttributes) delete properties[key]
    next.properties = properties
  }

  return next
}
