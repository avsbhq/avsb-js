/**
 * Phase 0 safety pin (integrations spec §8, finding F-2, decision D-1):
 * the browser SDK forwards NOTHING to third-party analytics.
 *
 * Until this phase, `AvsbClient.initTracker()` handed
 * `createIntegrationDispatcher(datafile)` to the tracker on every browser
 * init. That dispatcher auto-detected whatever analytics globals happened to
 * be on the page and pushed an `avsb_flag_evaluation` event to each of them
 * on every flag exposure. There was no opt-in, no config, and no way to turn
 * it off: installing `@avsbhq/browser` silently started writing into a
 * customer's Google Analytics, GTM dataLayer, Mixpanel, Segment and Amplitude.
 *
 * These tests pin the OFF state. Every analytics global is present and
 * watched; a full client lifecycle (init, flag evaluation, tracked event,
 * flush) must not touch a single one of them, while still queueing the
 * exposure to our own ingestion endpoint.
 *
 * `./integrations.ts` is now unreachable and is kept only as the starting
 * point for the Phase 2 rebuild, which reintroduces forwarding gated on an
 * integrations block in the datafile. When that lands, extend this file with
 * the opt-in cases; do not delete the OFF cases.
 *
 * Phase 2 (D-10) has landed: forwarding is back, gated on the datafile's
 * `integrations` block. The opt-in cases live in
 * `./integrations.dispatch.test.ts` rather than here so each file stays
 * readable; everything below is unchanged
 * and still pins the no-config state, which is the state of every project that
 * has not switched a destination on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AvsbClient } from './AvsbClient'
import type { ExposureEvent, FlagDatafile, Tracker } from './types'
import * as trackerModule from './tracker'

// ---------------------------------------------------------------------------
// Analytics doubles
// ---------------------------------------------------------------------------

/**
 * The globals an auto-detecting dispatcher keys off. gtag, dataLayer,
 * mixpanel, `analytics` (Segment) and amplitude are the five the removed
 * dispatcher probed. `heap` is here too because the snippet's adapter set
 * includes it and Phase 2 brings both surfaces to one adapter list: it should
 * be untouched before that work as well as after it.
 */
const ANALYTICS_GLOBAL_KEYS = [
  'gtag',
  'dataLayer',
  'mixpanel',
  'analytics',
  'amplitude',
  'heap',
] as const

/**
 * Adapters read `window.<name>`, not the bare identifier, so the doubles have
 * to be installed on `window` itself. Under happy-dom that is not the same
 * object as `globalThis`, which is why `vi.stubGlobal` is not used here.
 */
function browserGlobals(): Record<string, unknown> {
  return window as unknown as Record<string, unknown>
}

function installAnalyticsDoubles() {
  const doubles = {
    gtag: vi.fn(),
    mixpanelTrack: vi.fn(),
    segmentTrack: vi.fn(),
    amplitudeTrack: vi.fn(),
    heapTrack: vi.fn(),
    /** A real array, exactly like GTM's. Anything forwarded lands here. */
    dataLayer: [] as unknown[],
  }

  const globals = browserGlobals()
  globals.gtag = doubles.gtag
  globals.dataLayer = doubles.dataLayer
  globals.mixpanel = { track: doubles.mixpanelTrack }
  globals.analytics = { track: doubles.segmentTrack }
  globals.amplitude = { track: doubles.amplitudeTrack }
  globals.heap = { track: doubles.heapTrack }

  return doubles
}

type AnalyticsDoubles = ReturnType<typeof installAnalyticsDoubles>

function removeAnalyticsDoubles(): void {
  const globals = browserGlobals()
  for (const key of ANALYTICS_GLOBAL_KEYS) {
    delete globals[key]
  }
}

function expectNothingForwarded(doubles: AnalyticsDoubles): void {
  expect(doubles.gtag).not.toHaveBeenCalled()
  expect(doubles.mixpanelTrack).not.toHaveBeenCalled()
  expect(doubles.segmentTrack).not.toHaveBeenCalled()
  expect(doubles.amplitudeTrack).not.toHaveBeenCalled()
  expect(doubles.heapTrack).not.toHaveBeenCalled()
  expect(doubles.dataLayer).toEqual([])
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SDK_KEY = 'sdk_integrations_off'

const DATAFILE: FlagDatafile = {
  version: 1,
  projectType: 'FEATURE_FLAG',
  sdkKey: SDK_KEY,
  environmentKey: 'production',
  publishedAt: '2025-01-01T00:00:00Z',
  collectEndpoint: 'http://localhost:3001',
  audiences: [],
  flags: [
    {
      id: 'flag_checkout',
      key: 'checkout_redesign',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var_control',
      variations: [
        { id: 'var_control', key: 'control', value: false },
        { id: 'var_treatment', key: 'treatment', value: true },
      ],
      overrides: [],
      rules: [
        {
          id: 'rule_ab',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          // 100% of traffic into the rule, 100% of the rule into treatment.
          // An ab_test rule is the only non-holdout path that fires an
          // exposure, so this makes the exposure deterministic and keeps the
          // assertions below from passing vacuously.
          trafficAllocation: 1,
          variations: [{ variationId: 'var_treatment', percentage: 1 }],
        },
      ],
    },
  ],
}

function makeTrackerSpy(queued: ExposureEvent[]): Tracker {
  return {
    queue: (event) => {
      queued.push(event)
    },
    queueMetric: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('@avsbhq/browser third-party forwarding (OFF)', () => {
  let doubles: AnalyticsDoubles
  let client: AvsbClient | null = null

  beforeEach(() => {
    doubles = installAnalyticsDoubles()
    // Keep the tracker's flush off the network. MSW forwards unhandled
    // requests, so a stray collect POST would escape to a dead local port
    // during teardown; a sendBeacon that reports success short-circuits
    // sendBatch before it ever reaches fetch.
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => true) })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true } as Response))
    )
  })

  afterEach(async () => {
    if (client) await client.close()
    client = null
    removeAnalyticsDoubles()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function createClient(): AvsbClient {
    return new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'visitor-1' },
    })
  }

  it('touches no analytics global when a flag evaluation fires an exposure', async () => {
    client = createClient()
    await client.onReady()

    const flag = client.getFlag('checkout_redesign', false)

    // The rule matched, so an exposure was fired. This is exactly the
    // evaluation the removed dispatcher used to forward.
    expect(flag.value).toBe(true)
    expect(flag.variationKey).toBe('treatment')

    expectNothingForwarded(doubles)
  })

  it('touches no analytics global across bulk exposures, a tracked event and a flush', async () => {
    client = createClient()
    await client.onReady()

    const flags = client.getAllFlags({ fireExposures: true })
    client.track('purchase')
    await client.flush()

    expect(flags['checkout_redesign']?.value).toBe(true)
    expectNothingForwarded(doubles)
  })

  it('still queues the exposure to our own ingestion, carrying the ids forwarding keyed on', async () => {
    const queued: ExposureEvent[] = []
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(
      makeTrackerSpy(queued)
    )

    client = createClient()
    await client.onReady()
    client.getFlag('checkout_redesign', false)

    // Removing forwarding must not remove our own exposure tracking.
    expect(queued).toHaveLength(1)
    expect(queued[0].properties?.flagId).toBe('flag_checkout')
    expect(queued[0].variationId).toBe('var_treatment')
    expect(queued[0].experimentId).toBe('rule_ab')
    expect(queued[0].visitorId).toBe('visitor-1')

    expectNothingForwarded(doubles)
  })

  it('builds the tracker with no event callback, so nothing can subscribe to exposures', async () => {
    const createTrackerSpy = vi.spyOn(trackerModule, 'createTracker')

    client = createClient()
    await client.onReady()

    // Structural half of the pin: re-adding a dispatcher means passing a
    // third argument here, which this assertion catches even if a future
    // adapter reads globals these tests do not install.
    expect(createTrackerSpy).toHaveBeenCalledTimes(1)
    const [sdkKey, collectEndpoint, onEvent] = createTrackerSpy.mock.calls[0]
    expect(sdkKey).toBe(SDK_KEY)
    expect(collectEndpoint).toBe(DATAFILE.collectEndpoint)
    expect(onEvent).toBeUndefined()
  })
})
