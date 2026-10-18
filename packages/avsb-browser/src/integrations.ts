/**
 * Third-party forwarding for `@avsbhq/browser` (analytics integrations spec
 * §10, D-10) — Phase 2 rebuild.
 *
 * WHAT CHANGED. Before Phase 0 this module auto-detected every analytics global
 * on the page and pushed a flag-evaluation event to each of them on every
 * exposure, with no opt-in and no way to turn it off (finding F-2). It was cut
 * out entirely in Phase 0. It is back here as a CONFIG-GATED dispatcher: a
 * destination receives an event only because someone switched that destination
 * on in project settings, and that decision reaches the SDK through the flag
 * datafile's `integrations` block.
 *
 * THE THREE RULES this module holds:
 *
 * 1. **Config-gated.** No `integrations` block (or an empty one) means
 *    `createIntegrationDispatcher` returns `null` and the client never wires it
 *    up: zero calls, zero global reads at dispatch time. Only enabled rows are
 *    ever emitted server-side, so a row's PRESENCE is the on switch, and the
 *    entitlement strip empties the list for an org that may not forward.
 * 2. **Detect-only.** Adapters read a global that is already there. Nothing
 *    here loads, injects, or creates a vendor script or global — including
 *    `window.dataLayer`, which is pushed to only when the page already has it.
 * 3. **Per-adapter fault isolation.** One destination throwing (a half-loaded
 *    vendor SDK, a wrapped global) never blocks another destination and never
 *    reaches flag evaluation.
 *
 * PAYLOAD. Every destination renders the same canonical record (spec §2) with
 * the flag surface substituted for the experiment one: the flag key stands in
 * for `experiment_id`, the variation key for `variation_id`, and there is no
 * revenue or value on an exposure. `event_id` is minted per dispatched record
 * and shared across destinations, so the same exposure is joinable across
 * tools. The call shapes follow spec §4 per provider.
 */

import type { ExposureEvent, FlagDatafile } from './types'
import { generateEventId } from './tracker'

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

/**
 * Event name every destination uses for a flag exposure unless the customer
 * overrode `names.exposure` in project settings. Deliberately NOT each vendor's
 * native experiment-event name: on the flag surface these are flag
 * evaluations, not A/B experiment impressions, and mislabelling them would
 * pollute the vendor's built-in experiment reports.
 */
export const DEFAULT_FLAG_EVENT_NAME = 'avsb_flag_evaluation'

/**
 * Default `event` key for the GTM dataLayer push, matching the snippet
 * (`snippet/src/integrations.ts`), the settings card placeholder, and the GTM
 * doc's trigger instruction.
 *
 * This is the ONE name that is shared with the experiment surface rather than
 * flag-specific, and that is the point: a customer builds a single Custom Event
 * trigger on `avsb_experiment` and it catches web experiments and flag
 * evaluations alike. Telling them to build a second trigger for the SDK, when
 * the payload already distinguishes the two, would be a setup step that buys
 * nothing. `avsb_event_name` still carries the flag-specific
 * `avsb_flag_evaluation`, so a tag can branch on it; a customer-set `eventName`
 * still overrides this entirely.
 */
export const DEFAULT_GTM_DATALAYER_EVENT = 'avsb_experiment'

/**
 * How long after client init a configured-but-undetected destination is still
 * re-probed. Vendor snippets often load async, so a destination that was absent
 * when the client came up can activate a few seconds later. After the window
 * closes the destination stays off for the session rather than re-probing on
 * every exposure forever.
 */
const RETRY_WINDOW_MS = 30_000

// ---------------------------------------------------------------------------
// Canonical record
// ---------------------------------------------------------------------------

/**
 * The canonical record (spec §2) as the flag SDK produces it. Built once per
 * exposure and rendered per destination; `event_name` is the only field a
 * destination's config can change.
 */
export interface FlagIntegrationRecord {
  /** Flag key — the `experiment_id` analog on the flag surface. */
  experiment_id: string
  /** Flags carry no separate display name, so the key doubles as the name. */
  experiment_name: string
  /** Variation key — the `variation_id` analog. */
  variation_id: string
  variation_name: string
  event_type: 'exposure'
  event_name: string
  /**
   * The exposure's ingestion `eventId` (D-6 Path A), identical across every
   * destination AND identical to the id on our own row for this exposure, so a
   * customer can reconcile a vendor's report against our data. Minted here only
   * for an exposure that never reaches ingestion at all.
   */
  event_id: string
  timestamp: number
}

// ---------------------------------------------------------------------------
// Datafile config parsing
// ---------------------------------------------------------------------------

/**
 * A destination row after normalisation. The datafile is JSON fetched from a
 * CDN, so every field is re-checked here rather than trusted: a malformed row
 * degrades to "defaults" instead of sending a destination an `undefined` event
 * name.
 */
interface IntegrationRow {
  provider: string
  /** Resolved exposure event name: the override when set, else the default. */
  eventName: string
  /** GA4 `send_to` measurement id, when configured. */
  sendTo?: string
  /** GTM dataLayer `event` key, when configured. */
  dataLayerEvent?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readText(
  source: Record<string, unknown> | null,
  key: string
): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read the datafile's forwarding block.
 *
 * The cast keeps this compiling against a `@avsbhq/core` build that predates
 * the `integrations` field while behaving identically once core ships it: the
 * value is validated structurally either way, because it arrives as fetched
 * JSON.
 */
function readIntegrationRows(datafile: FlagDatafile): IntegrationRow[] {
  const block: unknown = (datafile as FlagDatafile & { integrations?: unknown })
    .integrations
  if (!Array.isArray(block)) return []

  const rows: IntegrationRow[] = []
  const candidates: unknown[] = block
  for (const candidate of candidates) {
    const row = asRecord(candidate)
    const provider = readText(row, 'provider')
    if (!provider) continue
    const names = asRecord(row?.names)
    rows.push({
      provider,
      eventName: readText(names, 'exposure') ?? DEFAULT_FLAG_EVENT_NAME,
      sendTo: readText(row, 'sendTo'),
      dataLayerEvent: readText(row, 'eventName'),
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Adapters (detect-only)
// ---------------------------------------------------------------------------

interface IntegrationAdapter {
  provider: string
  detect: () => boolean
  dispatch: (record: FlagIntegrationRecord, row: IntegrationRow) => void
}

/** `window` as an index signature, or null outside a browser. */
function globals(): Record<string, unknown> | null {
  return typeof window === 'undefined'
    ? null
    : (window as unknown as Record<string, unknown>)
}

/** True when `window.<name>.track` is callable (mixpanel/segment/amplitude shape). */
function hasTrackMethod(name: string): boolean {
  const holder = asRecord(globals()?.[name])
  return typeof holder?.track === 'function'
}

function trackVia(name: string): (event: string, props: Record<string, unknown>) => void {
  const holder = globals()?.[name] as {
    track: (event: string, props: Record<string, unknown>) => void
  }
  return (event, props) => holder.track(event, props)
}

const ADAPTERS: IntegrationAdapter[] = [
  {
    provider: 'google_analytics',
    detect: () => typeof globals()?.gtag === 'function',
    dispatch: (record, row) => {
      const gtag = globals()?.gtag as (
        command: string,
        eventName: string,
        params: Record<string, unknown>
      ) => void
      // Google's official A/B integration shape: GA4's pre-defined
      // "Experience - variant ID" dimension picks up `exp_variant_string`
      // with zero setup on the customer's side.
      gtag('event', record.event_name, {
        exp_variant_string: `AVSB-${record.experiment_id}-${record.variation_id}`,
        avsb_experiment_name: record.experiment_name,
        avsb_variation_name: record.variation_name,
        avsb_event_id: record.event_id,
        ...(row.sendTo ? { send_to: row.sendTo } : {}),
      })
    },
  },
  {
    provider: 'google_tag_manager',
    // Detect-only: push only into a dataLayer the page already created. We
    // never create it ourselves — an array we invented would be invisible to
    // a GTM container that loads later and reinitialises its own.
    detect: () => Array.isArray(globals()?.dataLayer),
    dispatch: (record, row) => {
      const dataLayer = globals()?.dataLayer as unknown[]
      dataLayer.push({
        event: row.dataLayerEvent ?? DEFAULT_GTM_DATALAYER_EVENT,
        avsb_experiment_id: record.experiment_id,
        avsb_experiment_name: record.experiment_name,
        avsb_variation_id: record.variation_id,
        avsb_variation_name: record.variation_name,
        avsb_event_name: record.event_name,
        avsb_event_id: record.event_id,
      })
    },
  },
  {
    provider: 'mixpanel',
    detect: () => hasTrackMethod('mixpanel'),
    dispatch: (record) => {
      // Exact casing is Mixpanel's Experiments contract; renaming these props
      // drops the event out of its experiment reports.
      trackVia('mixpanel')(record.event_name, {
        'Experiment name': record.experiment_name,
        'Variant name': record.variation_name,
        avsb_event_id: record.event_id,
      })
    },
  },
  {
    provider: 'segment',
    detect: () => hasTrackMethod('analytics'),
    dispatch: (record) => {
      trackVia('analytics')(record.event_name, {
        experiment_id: record.experiment_id,
        experiment_name: record.experiment_name,
        variation_id: record.variation_id,
        variation_name: record.variation_name,
        event_id: record.event_id,
        nonInteraction: 1,
      })
    },
  },
  {
    provider: 'amplitude',
    detect: () => hasTrackMethod('amplitude'),
    dispatch: (record) => {
      // Amplitude Experiment's own property names, so its exposure analysis
      // works without the customer mapping anything. `event_id` is unprefixed
      // here, matching the snippet's amplitude adapter, the docs and the UI
      // preview — a customer's Amplitude chart has to work the same whether the
      // event came from the snippet or the SDK.
      trackVia('amplitude')(record.event_name, {
        flag_key: record.experiment_id,
        variant: record.variation_name,
        experiment_key: record.experiment_name,
        event_id: record.event_id,
      })
    },
  },
]

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

interface ConfiguredAdapter {
  adapter: IntegrationAdapter
  row: IntegrationRow
}

/**
 * Resolve an exposure event against the datafile into the canonical record.
 * Returns null when the flag or variation cannot be resolved: a destination
 * gets nothing rather than a row with empty ids, which would be worse than
 * silence in the customer's reports.
 */
function buildRecord(
  datafile: FlagDatafile,
  event: ExposureEvent
): FlagIntegrationRecord | null {
  const flagId = event.properties?.flagId
  if (typeof flagId !== 'string') return null

  const flag = datafile.flags.find((f) => f.id === flagId)
  if (!flag) return null

  const variation = flag.variations.find((v) => v.id === event.variationId)
  if (!variation) return null

  return {
    experiment_id: flag.key,
    experiment_name: flag.key,
    variation_id: variation.key,
    variation_name: variation.key,
    event_type: 'exposure',
    event_name: DEFAULT_FLAG_EVENT_NAME,
    // Reuse the ingestion id (D-6 Path A). `AvsbClient.handleExposure` stamps
    // it before it queues the exposure to our own endpoint, so the vendor row
    // and our row join on this value. The fallback covers an exposure that
    // never went to ingestion (a direct dispatcher call), where there is no id
    // to reconcile with and a fresh one at least keeps destinations consistent
    // with each other.
    event_id: event.eventId ?? generateEventId(),
    timestamp: event.timestamp,
  }
}

/**
 * Build the exposure forwarder for a datafile, or `null` when this datafile
 * configures no destination this SDK can reach.
 *
 * Returning `null` (rather than a no-op function) is the contract that lets
 * `AvsbClient` skip wiring entirely, which is what keeps the "installing the
 * SDK forwards nothing" guarantee structural rather than a runtime early
 * return.
 */
export function createIntegrationDispatcher(
  datafile: FlagDatafile
): ((event: ExposureEvent) => void) | null {
  const rows = readIntegrationRows(datafile)
  if (rows.length === 0) return null

  // A row for a destination this SDK has no adapter for (heap, fullstory,
  // contentsquare, adobe — snippet-only today) is simply skipped: the config
  // is valid, this runtime just cannot reach it.
  const configured: ConfiguredAdapter[] = []
  for (const row of rows) {
    const adapter = ADAPTERS.find((a) => a.provider === row.provider)
    if (adapter) configured.push({ adapter, row })
  }
  if (configured.length === 0) return null

  const active: ConfiguredAdapter[] = []
  const pending: ConfiguredAdapter[] = []
  for (const entry of configured) {
    if (entry.adapter.detect()) active.push(entry)
    else pending.push(entry)
  }

  const startedAt = Date.now()

  return (event: ExposureEvent) => {
    const record = buildRecord(datafile, event)
    if (!record) return

    // Late activation: a configured destination whose global appeared after
    // init joins the active set on the next exposure inside the window.
    if (pending.length > 0 && Date.now() - startedAt < RETRY_WINDOW_MS) {
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].adapter.detect()) {
          active.push(pending[i])
          pending.splice(i, 1)
        }
      }
    }

    for (const { adapter, row } of active) {
      try {
        adapter.dispatch({ ...record, event_name: row.eventName }, row)
      } catch {
        // Fault isolation: a broken destination never breaks another one, and
        // never breaks flag evaluation. Nothing is logged here because this
        // runs on the customer's page on every exposure; the SDK's logger is
        // deliberately not threaded in.
      }
    }
  }
}
