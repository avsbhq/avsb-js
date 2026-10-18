/**
 * Tracker durability (WS2 item 4, report 02 §5.9).
 *
 * The bug: `flush()` dequeued both buffers BEFORE sending and swallowed
 * every fetch error, so one failed flush destroyed those events silently.
 * No retry, no re-enqueue, no log, in the SDK that runs on flaky consumer
 * networks. These tests pin the replacement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExposureEvent, Logger, MetricEvent, Tracker } from './types'
import { createTracker } from './tracker'

const ENDPOINT = 'https://ingest.avsb.cloud'
const BATCH_URL = 'https://ingest.avsb.cloud/v1/collect/batch'
const METRIC_URL = 'https://ingest.avsb.cloud/v1/collect/metric-batch'

function exposure(overrides: Partial<ExposureEvent> = {}): ExposureEvent {
  return {
    visitorId: 'visitor-1',
    experimentId: 'exp-1',
    variationId: 'var-1',
    eventName: 'flag_exposure',
    revenue: null,
    timestamp: 1,
    pageUrl: 'https://example.com',
    ...overrides,
  }
}

function metric(overrides: Partial<MetricEvent> = {}): MetricEvent {
  return {
    visitorId: 'visitor-1',
    eventName: 'purchase',
    revenue: 9.99,
    timestamp: 1,
    pageUrl: 'https://example.com',
    ...overrides,
  }
}

function collectingLogger(): Logger & { messages: string[] } {
  const messages: string[] = []
  const logger: Logger & { messages: string[] } = {
    messages,
    debug: () => undefined,
    info: () => undefined,
    warn: (m: string) => messages.push(m),
    error: (m: string) => messages.push(m),
    child: () => logger,
  }
  return logger
}

interface Answer {
  ok?: boolean
  status?: number
  retryAfter?: string
  throws?: Error
}

function mockFetch(answers: Answer[]): ReturnType<typeof vi.fn> {
  let index = 0
  const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
    const answer = answers[Math.min(index, answers.length - 1)]
    index += 1
    if (answer.throws) return Promise.reject(answer.throws)
    const status = answer.status ?? 200
    return Promise.resolve({
      ok: answer.ok ?? (status >= 200 && status < 300),
      status,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'retry-after' ? answer.retryAfter ?? null : null,
      },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[call][1] as RequestInit
  return JSON.parse(init.body as string) as Record<string, unknown>
}

let tracker: Tracker | null = null

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  // Beacon off by default so the retryable fetch path is what runs.
  vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) })
})

afterEach(async () => {
  if (tracker) {
    await tracker.destroy()
    tracker = null
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createTracker — retry and re-enqueue', () => {
  it('retries a failed send on the backoff curve and delivers', async () => {
    const fetchMock = mockFetch([
      { throws: new TypeError('Failed to fetch') },
      { status: 200 },
    ])
    tracker = createTracker('sdk_key', ENDPOINT, undefined, { retryAttempts: 3 })
    tracker.queue(exposure())

    const flushing = tracker.flush()
    await vi.advanceTimersByTimeAsync(2000)
    await flushing

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe(BATCH_URL)
    // The same batch, byte for byte: retries must not re-mint eventIds or
    // ingestion cannot deduplicate them.
    expect(bodyOf(fetchMock, 1)).toEqual(bodyOf(fetchMock, 0))
    expect(tracker.size?.()).toEqual({ events: 0, metricEvents: 0 })
  })

  it('re-enqueues a batch that exhausts its retries instead of dropping it', async () => {
    const logger = collectingLogger()
    const fetchMock = mockFetch([{ status: 500 }])
    tracker = createTracker('sdk_key', ENDPOINT, undefined, {
      retryAttempts: 1,
      logger,
    })
    tracker.queue(exposure())

    const flushing = tracker.flush()
    // Just past the 1s first retry, and short of the next automatic flush,
    // so this asserts the retry count and nothing else.
    await vi.advanceTimersByTimeAsync(1100)
    await flushing

    // One attempt plus one retry, then back on the queue.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(tracker.size?.()).toEqual({ events: 1, metricEvents: 0 })
    expect(logger.messages.some((m) => m.includes('could not send'))).toBe(true)

    // The next flush resends the identical event.
    mockFetch([{ status: 200 }])
    await tracker.flush()
    expect(tracker.size?.()).toEqual({ events: 0, metricEvents: 0 })
  })

  it('keeps eventIds stable across a re-enqueue', async () => {
    mockFetch([{ status: 503 }])
    tracker = createTracker('sdk_key', ENDPOINT, undefined, { retryAttempts: 0 })
    tracker.queue(exposure())
    await tracker.flush()

    const okFetch = mockFetch([{ status: 200 }])
    await tracker.flush()

    const events = bodyOf(okFetch, 0)['events'] as Array<{ eventId: string }>
    expect(events).toHaveLength(1)
    expect(events[0].eventId).toEqual(expect.any(String))
  })

  it('honours a Retry-After header for the next attempt', async () => {
    const fetchMock = mockFetch([
      { status: 429, retryAfter: '3' },
      { status: 200 },
    ])
    tracker = createTracker('sdk_key', ENDPOINT, undefined, { retryAttempts: 2 })
    tracker.queue(exposure())

    const flushing = tracker.flush()
    // The curve would have retried after 1s; the header says 3s.
    await vi.advanceTimersByTimeAsync(2500)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(600)
    await flushing

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('drops the oldest events once the queue cap is reached, and says so', () => {
    const logger = collectingLogger()
    mockFetch([{ status: 200 }])
    tracker = createTracker('sdk_key', ENDPOINT, undefined, {
      maxQueueSize: 2,
      batchSize: 100,
      logger,
    })

    tracker.queue(exposure({ eventId: 'e1' }))
    tracker.queue(exposure({ eventId: 'e2' }))
    tracker.queue(exposure({ eventId: 'e3' }))

    expect(tracker.size?.().events).toBe(2)
    const warning = logger.messages.find((m) => m.includes('send queue is full'))
    expect(warning).toBeDefined()
    expect(warning).toContain('oldest')
    expect(warning).toContain('ingest.avsb.cloud')
  })

  it('never puts more than batchSize events in one request, and loses none', async () => {
    const fetchMock = mockFetch([{ status: 200 }])
    tracker = createTracker('sdk_key', ENDPOINT, undefined, { batchSize: 2 })

    for (let i = 0; i < 5; i++) tracker.queueMetric(metric({ eventId: `m${i}` }))
    // The batch threshold auto-flushes mid-loop, so drain everything the
    // chained flushes and the timer chain have queued before asserting.
    await tracker.flush()
    await vi.advanceTimersByTimeAsync(5000)

    const sentIds: string[] = []
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse((call[1] as RequestInit).body as string) as {
        metricEvents?: Array<{ eventId: string }>
      }
      const events = body.metricEvents ?? []
      expect(events.length).toBeLessThanOrEqual(2)
      for (const event of events) sentIds.push(event.eventId)
    }

    expect(new Set(sentIds)).toEqual(new Set(['m0', 'm1', 'm2', 'm3', 'm4']))
    expect(tracker.size?.()).toEqual({ events: 0, metricEvents: 0 })
  })

  it('sends exposures and metric events to their own endpoints', async () => {
    const fetchMock = mockFetch([{ status: 200 }])
    tracker = createTracker('sdk_key', ENDPOINT, undefined, { batchSize: 100 })

    tracker.queue(exposure())
    tracker.queueMetric(metric())
    await tracker.flush()

    const urls = fetchMock.mock.calls.map((call) => call[0])
    expect(urls).toContain(BATCH_URL)
    expect(urls).toContain(METRIC_URL)
  })

  it('builds collect URLs from a datafile that already carries the batch path', async () => {
    const fetchMock = mockFetch([{ status: 200 }])
    // The web-experiment datafile publishes the full batch URL. Appending
    // blindly used to produce /v1/collect/batch/v1/collect/batch.
    tracker = createTracker('sdk_key', 'https://ingest.avsb.cloud/v1/collect/batch')
    tracker.queue(exposure())
    await tracker.flush()

    expect(fetchMock.mock.calls[0][0]).toBe(BATCH_URL)
  })

  it('prefers sendBeacon on teardown, where a retry could not finish', async () => {
    // Typed parameters, so the captured URL below is a read off a real tuple:
    // a zero-parameter fake records calls as an empty tuple and `calls[0][0]`
    // cannot be read at all.
    const sendBeacon = vi.fn((_url: string, _body?: BodyInit) => true)
    vi.stubGlobal('navigator', { sendBeacon })
    const fetchMock = mockFetch([{ status: 200 }])
    tracker = createTracker('sdk_key', ENDPOINT)
    tracker.queue(exposure())

    await tracker.destroy()
    tracker = null

    expect(sendBeacon).toHaveBeenCalledTimes(1)
    expect(sendBeacon.mock.calls[0][0]).toBe(BATCH_URL)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses fetch, not beacon, for an ordinary flush so failures are visible', async () => {
    const sendBeacon = vi.fn(() => true)
    vi.stubGlobal('navigator', { sendBeacon })
    const fetchMock = mockFetch([{ status: 200 }])
    tracker = createTracker('sdk_key', ENDPOINT)
    tracker.queue(exposure())

    await tracker.flush()

    expect(sendBeacon).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the automatic flush loop alive across idle ticks', async () => {
    const fetchMock = mockFetch([{ status: 200 }])
    tracker = createTracker('sdk_key', ENDPOINT, undefined, { flushInterval: 1000 })

    // Idle ticks must not kill the timer chain, or automatic flushing stops
    // for the rest of the session after the first quiet interval.
    await vi.advanceTimersByTimeAsync(3000)
    expect(fetchMock).not.toHaveBeenCalled()

    tracker.queueMetric(metric())
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('backs the automatic flush off as failures pile up', async () => {
    const fetchMock = mockFetch([{ status: 500 }])
    tracker = createTracker('sdk_key', ENDPOINT, undefined, {
      flushInterval: 1000,
      retryAttempts: 0,
    })
    tracker.queueMetric(metric())

    // First automatic attempt at the plain interval.
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Second attempt one interval later; the curve is still at 1s.
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Now the curve is at 2s, so a dead endpoint is not hit every second by
    // every open tab.
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1100)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
