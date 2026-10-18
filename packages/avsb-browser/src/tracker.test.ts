import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExposureEvent, MetricEvent, Tracker } from './types'
import { createTracker, generateEventId } from './tracker'

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function makeExposure(overrides: Partial<ExposureEvent> = {}): ExposureEvent {
  return {
    visitorId: 'visitor-1',
    experimentId: 'exp-1',
    variationId: 'var-1',
    eventName: 'exposure',
    revenue: null,
    timestamp: 1,
    pageUrl: 'https://example.com',
    ...overrides,
  }
}

function makeMetric(overrides: Partial<MetricEvent> = {}): MetricEvent {
  return {
    visitorId: 'visitor-1',
    eventName: 'purchase',
    revenue: 9.99,
    timestamp: 1,
    pageUrl: 'https://example.com',
    ...overrides,
  }
}

describe('generateEventId', () => {
  it('produces a valid UUID v4', () => {
    expect(generateEventId()).toMatch(UUID_V4)
  })

  it('produces a distinct id on each call', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateEventId()))
    expect(ids.size).toBe(50)
  })
})

describe('createTracker — eventId stamping', () => {
  let tracker: Tracker
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Force the fetch path: sendBeacon returns false so flush falls through.
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) })
    fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    if (tracker) await tracker.destroy()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('stamps a valid eventId on an exposure event at enqueue time', () => {
    const seen: ExposureEvent[] = []
    tracker = createTracker('sdk-key', 'https://ingest.test', (e) => seen.push(e))

    tracker.queue(makeExposure())

    expect(seen).toHaveLength(1)
    expect(seen[0].eventId).toMatch(UUID_V4)
  })

  it('sends the same eventId observed at enqueue (id is fixed before the wire)', async () => {
    let enqueuedId: string | undefined
    tracker = createTracker('sdk-key', 'https://ingest.test', (e) => {
      enqueuedId = e.eventId
    })

    tracker.queue(makeExposure())
    await tracker.flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.events[0].eventId).toBe(enqueuedId)
    expect(body.events[0].eventId).toMatch(UUID_V4)
  })

  it('assigns distinct eventIds to distinct queued events', () => {
    const seen: ExposureEvent[] = []
    tracker = createTracker('sdk-key', 'https://ingest.test', (e) => seen.push(e))

    tracker.queue(makeExposure())
    tracker.queue(makeExposure())

    expect(seen[0].eventId).not.toBe(seen[1].eventId)
  })

  // D-6 Path A: AvsbClient stamps the id BEFORE it queues, so the same id can
  // also travel to third-party destinations. Overwriting it here would silently
  // break every vendor row's join back to our own row.
  it('keeps an eventId the caller already assigned', async () => {
    const seen: ExposureEvent[] = []
    tracker = createTracker('sdk-key', 'https://ingest.test', (e) => seen.push(e))

    tracker.queue(makeExposure({ eventId: 'caller-assigned-id' }))
    await tracker.flush()

    expect(seen[0].eventId).toBe('caller-assigned-id')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.events[0].eventId).toBe('caller-assigned-id')
  })

  it('stamps an eventId on metric events too', async () => {
    tracker = createTracker('sdk-key', 'https://ingest.test')

    tracker.queueMetric(makeMetric())
    await tracker.flush()

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.metricEvents[0].eventId).toMatch(UUID_V4)
  })
})
