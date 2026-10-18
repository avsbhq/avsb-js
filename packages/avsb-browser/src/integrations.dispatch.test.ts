/**
 * Third-party forwarding, ON (analytics integrations spec §10, D-10).
 *
 * Sibling of `./integrations.test.ts`, which pins the no-config OFF state that
 * every project starts in. This file pins the opposite end: what a destination
 * receives once someone switches it on in project settings, and that the switch
 * is the ONLY thing that turns it on.
 *
 * The payload assertions are deliberately exact (`toHaveBeenCalledWith`, not
 * `objectContaining`). These objects land in a customer's Google Analytics,
 * Mixpanel, Segment and Amplitude reports; a silently added, renamed or dropped
 * property is a reporting bug we would only hear about from the customer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AvsbClient } from './AvsbClient'
import { createIntegrationDispatcher } from './integrations'
import type { ExposureEvent, FlagDatafile, Tracker } from './types'
import * as trackerModule from './tracker'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SDK_KEY = 'sdk_integrations_on'
const FLAG_ID = 'flag_checkout'
const VARIATION_ID = 'var_treatment'

const BASE_DATAFILE: FlagDatafile = {
  version: 1,
  projectType: 'FEATURE_FLAG',
  sdkKey: SDK_KEY,
  environmentKey: 'production',
  publishedAt: '2025-01-01T00:00:00Z',
  collectEndpoint: 'http://localhost:3001',
  audiences: [],
  flags: [
    {
      id: FLAG_ID,
      key: 'checkout_redesign',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var_control',
      variations: [
        { id: 'var_control', key: 'control', value: false },
        { id: VARIATION_ID, key: 'treatment', value: true },
      ],
      overrides: [],
      rules: [
        {
          id: 'rule_ab',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [{ variationId: VARIATION_ID, percentage: 1 }],
        },
      ],
    },
  ],
}

/**
 * Attach an `integrations` block. Deliberately typed `unknown[]` so tests can
 * feed the malformed rows a CDN-fetched datafile could really contain; the
 * dispatcher validates every row structurally, so that is the honest input
 * type.
 */
function datafileWith(integrations: unknown[]): FlagDatafile {
  return { ...BASE_DATAFILE, integrations } as unknown as FlagDatafile
}

function gaRow(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'google_analytics',
    forward: { goals: false, purchases: false, recs: false },
    names: {},
    ...overrides,
  }
}

/** The id our own ingestion row for this exposure carries (D-6 Path A). */
const INGESTION_EVENT_ID = 'a1b2c3d4-0000-4000-8000-000000000001'

const exposure: ExposureEvent = {
  eventId: INGESTION_EVENT_ID,
  visitorId: 'visitor-1',
  experimentId: 'rule_ab',
  variationId: VARIATION_ID,
  eventName: 'exposure',
  revenue: null,
  timestamp: 1_700_000_000_000,
  pageUrl: 'https://shop.example/checkout',
  properties: { flagId: FLAG_ID },
}

// ---------------------------------------------------------------------------
// Analytics doubles
// ---------------------------------------------------------------------------

const ANALYTICS_GLOBAL_KEYS = ['gtag', 'dataLayer', 'mixpanel', 'analytics', 'amplitude'] as const

function browserGlobals(): Record<string, unknown> {
  return window as unknown as Record<string, unknown>
}

function installDoubles() {
  const doubles = {
    gtag: vi.fn(),
    mixpanelTrack: vi.fn(),
    segmentTrack: vi.fn(),
    amplitudeTrack: vi.fn(),
    dataLayer: [] as unknown[],
  }
  const globals = browserGlobals()
  globals.gtag = doubles.gtag
  globals.dataLayer = doubles.dataLayer
  globals.mixpanel = { track: doubles.mixpanelTrack }
  globals.analytics = { track: doubles.segmentTrack }
  globals.amplitude = { track: doubles.amplitudeTrack }
  return doubles
}

function removeDoubles(): void {
  const globals = browserGlobals()
  for (const key of ANALYTICS_GLOBAL_KEYS) delete globals[key]
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

describe('createIntegrationDispatcher — config gating', () => {
  let doubles: ReturnType<typeof installDoubles>

  beforeEach(() => {
    doubles = installDoubles()
  })
  afterEach(() => {
    removeDoubles()
    vi.restoreAllMocks()
  })

  it('returns null when the datafile carries no integrations block at all', () => {
    expect(createIntegrationDispatcher(BASE_DATAFILE)).toBeNull()
  })

  it('returns null for an empty block, which is what the entitlement strip writes', () => {
    expect(createIntegrationDispatcher(datafileWith([]))).toBeNull()
  })

  it('returns null when every configured destination is one this SDK has no adapter for', () => {
    const dispatcher = createIntegrationDispatcher(
      datafileWith([{ provider: 'heap', names: {} }, { provider: 'fullstory', names: {} }])
    )
    expect(dispatcher).toBeNull()
  })

  it('ignores unreachable destinations but still dispatches to the reachable ones', () => {
    const dispatcher = createIntegrationDispatcher(
      datafileWith([{ provider: 'heap', names: {} }, gaRow()])
    )
    dispatcher?.(exposure)
    expect(doubles.gtag).toHaveBeenCalledTimes(1)
  })

  it('sends nothing to a destination that is absent from the block', () => {
    createIntegrationDispatcher(datafileWith([gaRow()]))?.(exposure)

    expect(doubles.gtag).toHaveBeenCalledTimes(1)
    expect(doubles.mixpanelTrack).not.toHaveBeenCalled()
    expect(doubles.segmentTrack).not.toHaveBeenCalled()
    expect(doubles.amplitudeTrack).not.toHaveBeenCalled()
    expect(doubles.dataLayer).toEqual([])
  })

  it('skips a row with no usable provider string instead of throwing', () => {
    const dispatcher = createIntegrationDispatcher(
      datafileWith([{ names: {} }, null, 'nonsense', gaRow()])
    )
    dispatcher?.(exposure)
    expect(doubles.gtag).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Per-provider payloads (spec §4, adapted to the flag surface)
// ---------------------------------------------------------------------------

describe('createIntegrationDispatcher — payloads', () => {
  let doubles: ReturnType<typeof installDoubles>

  beforeEach(() => {
    doubles = installDoubles()
  })
  afterEach(() => {
    removeDoubles()
    vi.restoreAllMocks()
  })

  it('renders the Google Analytics exposure in the official A/B integration shape', () => {
    createIntegrationDispatcher(datafileWith([gaRow({ sendTo: 'G-ABC123' })]))?.(exposure)

    expect(doubles.gtag).toHaveBeenCalledTimes(1)
    const [command, eventName, params] = doubles.gtag.mock.calls[0]
    expect(command).toBe('event')
    expect(eventName).toBe('avsb_flag_evaluation')
    expect(params).toEqual({
      exp_variant_string: 'AVSB-checkout_redesign-treatment',
      avsb_experiment_name: 'checkout_redesign',
      avsb_variation_name: 'treatment',
      avsb_event_id: INGESTION_EVENT_ID,
      send_to: 'G-ABC123',
    })
  })

  it('omits send_to entirely when no measurement id is configured', () => {
    createIntegrationDispatcher(datafileWith([gaRow()]))?.(exposure)

    expect('send_to' in doubles.gtag.mock.calls[0][2]).toBe(false)
  })

  it('uses the names.exposure override in place of the default event name', () => {
    createIntegrationDispatcher(
      datafileWith([gaRow({ names: { exposure: 'flag_seen' } })])
    )?.(exposure)

    expect(doubles.gtag.mock.calls[0][1]).toBe('flag_seen')
  })

  it('falls back to the default name when the override is empty or not a string', () => {
    createIntegrationDispatcher(datafileWith([gaRow({ names: { exposure: '' } })]))?.(exposure)
    createIntegrationDispatcher(datafileWith([gaRow({ names: { exposure: 7 } })]))?.(exposure)

    expect(doubles.gtag.mock.calls[0][1]).toBe('avsb_flag_evaluation')
    expect(doubles.gtag.mock.calls[1][1]).toBe('avsb_flag_evaluation')
  })

  // The dataLayer `event` key defaults to the SAME name the snippet pushes, so
  // one Custom Event trigger on `avsb_experiment` catches web experiments and
  // flag evaluations alike. `avsb_event_name` is what tells the two apart.
  it('pushes the Google Tag Manager row onto the existing dataLayer', () => {
    createIntegrationDispatcher(
      datafileWith([{ provider: 'google_tag_manager', names: {} }])
    )?.(exposure)

    expect(doubles.dataLayer).toEqual([
      {
        event: 'avsb_experiment',
        avsb_experiment_id: 'checkout_redesign',
        avsb_experiment_name: 'checkout_redesign',
        avsb_variation_id: 'treatment',
        avsb_variation_name: 'treatment',
        avsb_event_name: 'avsb_flag_evaluation',
        avsb_event_id: INGESTION_EVENT_ID,
      },
    ])
  })

  it('lets the GTM eventName config drive the dataLayer event key independently of the payload name', () => {
    createIntegrationDispatcher(
      datafileWith([
        {
          provider: 'google_tag_manager',
          names: { exposure: 'flag_seen' },
          eventName: 'flag_rollouts',
        },
      ])
    )?.(exposure)

    const pushed = doubles.dataLayer[0] as Record<string, unknown>
    // A customer-set eventName wins over the shared default...
    expect(pushed.event).toBe('flag_rollouts')
    // ...and the payload name stays the separate knob it always was.
    expect(pushed.avsb_event_name).toBe('flag_seen')
  })

  it('renders Mixpanel with its Experiments property casing', () => {
    createIntegrationDispatcher(datafileWith([{ provider: 'mixpanel', names: {} }]))?.(exposure)

    expect(doubles.mixpanelTrack).toHaveBeenCalledWith('avsb_flag_evaluation', {
      'Experiment name': 'checkout_redesign',
      'Variant name': 'treatment',
      avsb_event_id: INGESTION_EVENT_ID,
    })
  })

  it('renders Segment in its A/B spec shape', () => {
    createIntegrationDispatcher(datafileWith([{ provider: 'segment', names: {} }]))?.(exposure)

    expect(doubles.segmentTrack).toHaveBeenCalledWith('avsb_flag_evaluation', {
      experiment_id: 'checkout_redesign',
      experiment_name: 'checkout_redesign',
      variation_id: 'treatment',
      variation_name: 'treatment',
      event_id: INGESTION_EVENT_ID,
      nonInteraction: 1,
    })
  })

  // `event_id` is unprefixed here, unlike GA/GTM/Mixpanel. That is not an
  // inconsistency to tidy up: it is the key the snippet's amplitude adapter,
  // the docs and the UI preview all use, and a customer's Amplitude chart must
  // not care whether the event came from the snippet or the SDK.
  it('renders Amplitude with its Experiment property names', () => {
    createIntegrationDispatcher(datafileWith([{ provider: 'amplitude', names: {} }]))?.(exposure)

    expect(doubles.amplitudeTrack).toHaveBeenCalledWith('avsb_flag_evaluation', {
      flag_key: 'checkout_redesign',
      variant: 'treatment',
      experiment_key: 'checkout_redesign',
      event_id: INGESTION_EVENT_ID,
    })
  })

  // D-6 Path A. This is the whole point of reusing the ingestion id: a customer
  // looking at an avsb_flag_evaluation row in GA can find OUR row for the same
  // exposure, and vice versa. Minting per destination would have made that
  // impossible with no error to notice.
  it('reuses the exposure ingestion eventId, so every destination joins our own row', () => {
    createIntegrationDispatcher(
      datafileWith([gaRow(), { provider: 'segment', names: {} }])
    )?.(exposure)

    expect(doubles.gtag.mock.calls[0][2].avsb_event_id).toBe(INGESTION_EVENT_ID)
    expect(doubles.segmentTrack.mock.calls[0][1].event_id).toBe(INGESTION_EVENT_ID)
  })

  it('gives each exposure its own id, carried consistently across destinations', () => {
    const dispatcher = createIntegrationDispatcher(
      datafileWith([gaRow(), { provider: 'segment', names: {} }])
    )
    dispatcher?.(exposure)
    dispatcher?.({ ...exposure, eventId: 'a1b2c3d4-0000-4000-8000-000000000002' })

    const firstGa = doubles.gtag.mock.calls[0][2].avsb_event_id
    const firstSegment = doubles.segmentTrack.mock.calls[0][1].event_id
    const secondGa = doubles.gtag.mock.calls[1][2].avsb_event_id

    expect(firstGa).toBe(firstSegment)
    expect(secondGa).not.toBe(firstGa)
  })

  it('mints an id only for an exposure that never reached ingestion', () => {
    const { eventId: _unused, ...noIngestionRow } = exposure

    createIntegrationDispatcher(
      datafileWith([gaRow(), { provider: 'segment', names: {} }])
    )?.(noIngestionRow)

    const ga = doubles.gtag.mock.calls[0][2].avsb_event_id
    // Nothing to reconcile with, but the destinations still agree with each
    // other about which exposure this was.
    expect(ga).toEqual(expect.any(String))
    expect(ga).not.toBe(INGESTION_EVENT_ID)
    expect(doubles.segmentTrack.mock.calls[0][1].event_id).toBe(ga)
  })

  it('sends nothing when the exposure cannot be resolved back to a flag and variation', () => {
    const dispatcher = createIntegrationDispatcher(datafileWith([gaRow()]))

    dispatcher?.({ ...exposure, properties: {} })
    dispatcher?.({ ...exposure, properties: { flagId: 'flag_unknown' } })
    dispatcher?.({ ...exposure, variationId: 'var_gone' })

    // Better silence than rows with empty ids in a customer's reports.
    expect(doubles.gtag).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Detection + fault isolation
// ---------------------------------------------------------------------------

describe('createIntegrationDispatcher — detection and fault isolation', () => {
  afterEach(() => {
    removeDoubles()
    vi.restoreAllMocks()
  })

  it('never creates a global for a destination that is not on the page', () => {
    const dispatcher = createIntegrationDispatcher(
      datafileWith([gaRow(), { provider: 'google_tag_manager', names: {} }])
    )

    dispatcher?.(exposure)

    // Detect-only: no gtag shim, and no dataLayer array invented for a GTM
    // container that may reinitialise its own later.
    expect('gtag' in browserGlobals()).toBe(false)
    expect('dataLayer' in browserGlobals()).toBe(false)
  })

  it('activates a destination that loads after init, inside the retry window', () => {
    const dispatcher = createIntegrationDispatcher(datafileWith([gaRow()]))
    const gtag = vi.fn()
    browserGlobals().gtag = gtag

    dispatcher?.(exposure)

    expect(gtag).toHaveBeenCalledTimes(1)
  })

  it('keeps dispatching to healthy destinations when one throws', () => {
    const doubles = installDoubles()
    doubles.gtag.mockImplementation(() => {
      throw new Error('vendor sdk half-loaded')
    })

    const dispatch = createIntegrationDispatcher(
      datafileWith([gaRow(), { provider: 'mixpanel', names: {} }])
    )

    expect(() => dispatch?.(exposure)).not.toThrow()
    expect(doubles.mixpanelTrack).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Client wiring
// ---------------------------------------------------------------------------

describe('AvsbClient wiring', () => {
  let doubles: ReturnType<typeof installDoubles>
  let client: AvsbClient | null = null

  beforeEach(() => {
    doubles = installDoubles()
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => true) })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true } as Response)))
  })

  afterEach(async () => {
    if (client) await client.close()
    client = null
    removeDoubles()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function createClient(datafile: FlagDatafile): Promise<AvsbClient> {
    const instance = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile,
      autoRefresh: false,
      context: { kind: 'user', key: 'visitor-1' },
    })
    await instance.onReady()
    return instance
  }

  it('forwards a flag evaluation once a destination is configured', async () => {
    client = await createClient(datafileWith([gaRow({ sendTo: 'G-ABC123' })]))

    client.getFlag('checkout_redesign', false)

    expect(doubles.gtag).toHaveBeenCalledTimes(1)
    expect(doubles.gtag.mock.calls[0][2].exp_variant_string).toBe(
      'AVSB-checkout_redesign-treatment'
    )
  })

  it('forwards nothing for a bulk read that suppresses exposures', async () => {
    client = await createClient(datafileWith([gaRow()]))

    client.getAllFlags()

    expect(doubles.gtag).not.toHaveBeenCalled()
  })

  // The end-to-end half of D-6 Path A: not just "the dispatcher reuses an id it
  // was handed", but "the id the vendor receives IS the id on our own row".
  it('sends the vendor the same event_id it queued to our own ingestion', async () => {
    const queued: ExposureEvent[] = []
    const trackerSpy: Tracker = {
      queue: (event) => {
        queued.push(event)
      },
      queueMetric: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
    }
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(trackerSpy)

    client = await createClient(datafileWith([gaRow()]))
    client.getFlag('checkout_redesign', false)

    expect(queued).toHaveLength(1)
    expect(queued[0].eventId).toEqual(expect.any(String))
    expect(doubles.gtag.mock.calls[0][2].avsb_event_id).toBe(queued[0].eventId)
  })

  it('does not subscribe to our own outbound event queue, configured or not', async () => {
    const createTrackerSpy = vi.spyOn(trackerModule, 'createTracker')

    client = await createClient(datafileWith([gaRow()]))

    // Forwarding hangs off the evaluation seam, never off the tracker: the
    // Phase 0 structural pin holds even with destinations switched on.
    expect(createTrackerSpy).toHaveBeenCalledTimes(1)
    expect(createTrackerSpy.mock.calls[0][2]).toBeUndefined()
  })

  it('stops forwarding after close', async () => {
    client = await createClient(datafileWith([gaRow()]))
    await client.close()
    const closed = client
    client = null

    closed.getFlag('checkout_redesign', false)

    expect(doubles.gtag).not.toHaveBeenCalled()
  })
})
