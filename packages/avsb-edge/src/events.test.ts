// =====================================================================
// events.ts — wire bodies and the request-scoped queue (B7).
//
// The exact-field assertions here are the contract with
// packages/avsb-conformance/fixtures/wire/manifest.json. They use toEqual on
// whole objects on purpose: a `toMatchObject` would pass while an extra field
// rode along, and an extra field on the exposure batch is what the ingestion
// worker rejects.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { COLLECT_PATHS } from '@avsbhq/core'
import {
  MAX_BATCH_ITEMS,
  buildExposureBatchBody,
  buildHeartbeatBody,
  buildMetricBatchBody,
  createEdgeEventQueue,
  generateEventId,
  type StampedExposureEvent,
  type StampedMetricEvent,
} from './events'
import { SDK_TYPE, SDK_VERSION } from './version'
import { VALID_SDK_KEY, captureLogger, jsonResponse } from './fixtures'

const exposure: StampedExposureEvent = {
  eventId: '8f14e45f-ceea-467a-9c1e-8b1d4f0b2b11',
  visitorId: 'user_42',
  experimentId: 'rule_ab_split',
  variationId: 'var_treatment',
  eventName: 'flag_exposure',
  revenue: null,
  timestamp: 1780000000000,
  pageUrl: '',
  properties: { flagKey: 'checkout-v2', flagId: 'flag_ab' },
}

const metric: StampedMetricEvent = {
  eventId: '6b1f2c93-4d5a-4f2b-8a3e-7c9d0e1f2a34',
  visitorId: 'user_42',
  eventName: 'signup_completed',
  revenue: null,
  timestamp: 1780000000000,
  pageUrl: '',
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------
// Wire bodies
// ---------------------------------------------------------------------

describe('buildExposureBatchBody', () => {
  it('emits exactly the locked exposure batch fields', () => {
    expect(buildExposureBatchBody(VALID_SDK_KEY, [exposure])).toEqual({
      sdkKey: VALID_SDK_KEY,
      events: [
        {
          eventId: '8f14e45f-ceea-467a-9c1e-8b1d4f0b2b11',
          visitorId: 'user_42',
          experimentId: 'rule_ab_split',
          variationId: 'var_treatment',
          eventName: 'flag_exposure',
          revenue: null,
          timestamp: 1780000000000,
          pageUrl: '',
          properties: { flagKey: 'checkout-v2', flagId: 'flag_ab' },
        },
      ],
    })
  })

  it('drops nothing required and adds nothing optional that was absent', () => {
    const [item] = buildExposureBatchBody(VALID_SDK_KEY, [
      { ...exposure, properties: undefined },
    ]).events

    expect(Object.keys(item).sort()).toEqual([
      'eventId',
      'eventName',
      'experimentId',
      'pageUrl',
      'revenue',
      'timestamp',
      'variationId',
      'visitorId',
    ])
  })

  it('carries attributes and an empty pageUrl through untouched', () => {
    const [item] = buildExposureBatchBody(VALID_SDK_KEY, [
      { ...exposure, attributes: { plan: 'pro' } },
    ]).events

    expect(item.attributes).toEqual({ plan: 'pro' })
    // An empty string is valid on the wire and is what a server SDK sends.
    expect(item.pageUrl).toBe('')
  })

  it('uses the holdout event name when the exposure carries it', () => {
    const [item] = buildExposureBatchBody(VALID_SDK_KEY, [
      { ...exposure, eventName: 'flag_holdout_exposure', experimentId: 'holdout_q2' },
    ]).events

    expect(item.eventName).toBe('flag_holdout_exposure')
    expect(item.experimentId).toBe('holdout_q2')
  })
})

describe('buildMetricBatchBody', () => {
  it('emits exactly the locked metric batch fields', () => {
    expect(buildMetricBatchBody(VALID_SDK_KEY, [metric])).toEqual({
      sdkKey: VALID_SDK_KEY,
      metricEvents: [
        {
          eventId: '6b1f2c93-4d5a-4f2b-8a3e-7c9d0e1f2a34',
          visitorId: 'user_42',
          eventName: 'signup_completed',
          revenue: null,
          timestamp: 1780000000000,
          pageUrl: '',
        },
      ],
    })
  })

  it('carries revenue as a number when the metric is a conversion with money', () => {
    const [item] = buildMetricBatchBody(VALID_SDK_KEY, [{ ...metric, revenue: 49.99 }])
      .metricEvents

    expect(item.revenue).toBe(49.99)
  })

  it('never puts experimentId or variationId on a metric event', () => {
    const [item] = buildMetricBatchBody(VALID_SDK_KEY, [metric]).metricEvents

    // Attribution happens server-side from the visitor's exposures. A metric
    // event that carried an experiment would double-attribute.
    expect(Object.keys(item)).not.toContain('experimentId')
    expect(Object.keys(item)).not.toContain('variationId')
  })
})

describe('buildHeartbeatBody', () => {
  it('emits exactly {sdkKey, sdkType, sdkVersion}', () => {
    expect(buildHeartbeatBody(VALID_SDK_KEY)).toEqual({
      sdkKey: VALID_SDK_KEY,
      sdkType: '@avsbhq/edge',
      sdkVersion: SDK_VERSION,
    })
  })

  it('reports the package identifier exactly as published', () => {
    expect(SDK_TYPE).toBe('@avsbhq/edge')
  })
})

describe('generateEventId', () => {
  it('produces a distinct id per call', () => {
    const ids = new Set([generateEventId(), generateEventId(), generateEventId()])
    expect(ids.size).toBe(3)
  })

  it('produces a v4-shaped uuid even without crypto.randomUUID', () => {
    vi.stubGlobal('crypto', {})
    expect(generateEventId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})

// ---------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------

describe('createEdgeEventQueue endpoints', () => {
  it('appends the collect paths to a datafile origin', () => {
    const queue = createEdgeEventQueue({
      sdkKey: VALID_SDK_KEY,
      collectEndpoint: () => 'https://ingest.avsb.cloud',
      logger: captureLogger(),
    })

    expect(queue.endpoints()).toEqual({
      batch: 'https://ingest.avsb.cloud/v1/collect/batch',
      metricBatch: 'https://ingest.avsb.cloud/v1/collect/metric-batch',
    })
  })

  it('does not double the path when the datafile publishes a full collect URL', () => {
    const queue = createEdgeEventQueue({
      sdkKey: VALID_SDK_KEY,
      collectEndpoint: () => 'https://ingest.avsb.cloud/v1/collect/batch',
      logger: captureLogger(),
    })

    expect(queue.endpoints().batch).toBe('https://ingest.avsb.cloud/v1/collect/batch')
  })

  it('falls back to the public ingest host when the datafile carries no endpoint', () => {
    const queue = createEdgeEventQueue({ sdkKey: VALID_SDK_KEY, logger: captureLogger() })

    expect(queue.endpoints().batch).toBe(`https://ingest.avsb.cloud${COLLECT_PATHS.batch}`)
  })

  it('honours a self-hosted collect origin', () => {
    const queue = createEdgeEventQueue({
      sdkKey: VALID_SDK_KEY,
      collectEndpoint: () => 'https://events.customer.example',
      logger: captureLogger(),
    })

    expect(queue.endpoints().metricBatch).toBe(
      'https://events.customer.example/v1/collect/metric-batch',
    )
  })
})

// ---------------------------------------------------------------------
// Queue behaviour
// ---------------------------------------------------------------------

describe('createEdgeEventQueue', () => {
  it('mints an eventId when the caller did not', () => {
    const queue = createEdgeEventQueue({ sdkKey: VALID_SDK_KEY, logger: captureLogger() })

    const stamped = queue.queueExposure({ ...exposure, eventId: undefined })

    expect(stamped.eventId).toBeTruthy()
    expect(stamped.eventId).not.toBe('')
  })

  it('keeps an eventId the caller already assigned', () => {
    const queue = createEdgeEventQueue({ sdkKey: VALID_SDK_KEY, logger: captureLogger() })

    // One decision has one id everywhere it is reported, so a customer's own
    // analytics row and our ingestion row reconcile.
    expect(queue.queueExposure(exposure).eventId).toBe(exposure.eventId)
  })

  it('sends the same eventIds on a retry so ingestion can deduplicate', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ accepted: 1 }))
    vi.stubGlobal('fetch', mockFetch)

    const queue = createEdgeEventQueue({
      sdkKey: VALID_SDK_KEY,
      logger: captureLogger(),
      retryAttempts: 1,
      retryDelayMs: 0,
    })
    queue.queueExposure({ ...exposure, eventId: undefined })

    await queue.flush()

    expect(mockFetch).toHaveBeenCalledTimes(2)
    const [, first] = mockFetch.mock.calls[0] as [string, RequestInit]
    const [, second] = mockFetch.mock.calls[1] as [string, RequestInit]
    // Byte-identical, not merely equivalent: the body is serialised once.
    expect(second.body).toBe(first.body)
  })

  it('logs the endpoint, the count, and the attempt total when a batch is lost', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 })))
    const logger = captureLogger()

    const queue = createEdgeEventQueue({
      sdkKey: VALID_SDK_KEY,
      logger,
      retryAttempts: 0,
    })
    queue.queueExposure(exposure)
    await queue.flush()

    const warning = logger.messages('warn').join('\n')
    expect(warning).toContain('/v1/collect/batch')
    expect(warning).toContain('1 exposure events')
    expect(warning).toContain('HTTP 500')
    // Honest about the edge lifecycle: there is no later flush to retry on.
    expect(warning).toContain('lost rather than retried later')
  })

  it('posts exposures and tracked events to their own endpoints in one flush', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }))
    vi.stubGlobal('fetch', mockFetch)

    const queue = createEdgeEventQueue({
      sdkKey: VALID_SDK_KEY,
      collectEndpoint: () => 'https://ingest.avsb.cloud',
      logger: captureLogger(),
    })
    queue.queueExposure(exposure)
    queue.queueMetric(metric)

    await queue.flush()

    const urls = mockFetch.mock.calls.map((call) => (call as [string])[0]).sort()
    expect(urls).toEqual([
      'https://ingest.avsb.cloud/v1/collect/batch',
      'https://ingest.avsb.cloud/v1/collect/metric-batch',
    ])
  })

  it('is a no-op with nothing queued', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    await createEdgeEventQueue({ sdkKey: VALID_SDK_KEY, logger: captureLogger() }).flush()

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('clears the queue on flush so a second flush sends nothing', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }))
    vi.stubGlobal('fetch', mockFetch)

    const queue = createEdgeEventQueue({ sdkKey: VALID_SDK_KEY, logger: captureLogger() })
    queue.queueExposure(exposure)

    await queue.flush()
    await queue.flush()

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(queue.size()).toEqual({ events: 0, metricEvents: 0 })
  })

  it('splits a queue larger than the wire cap into separate requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }))
    vi.stubGlobal('fetch', mockFetch)

    const queue = createEdgeEventQueue({
      sdkKey: VALID_SDK_KEY,
      logger: captureLogger(),
      maxQueueSize: 250,
    })
    for (let i = 0; i < MAX_BATCH_ITEMS + 1; i++) {
      queue.queueExposure({ ...exposure, eventId: `id-${i}` })
    }

    await queue.flush()

    expect(mockFetch).toHaveBeenCalledTimes(2)
    const first = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect((first as { events: unknown[] }).events).toHaveLength(MAX_BATCH_ITEMS)
  })

  it('drops the oldest past the cap and says so, naming the cap', () => {
    const logger = captureLogger()
    const queue = createEdgeEventQueue({
      sdkKey: VALID_SDK_KEY,
      logger,
      maxQueueSize: 2,
    })

    queue.queueExposure({ ...exposure, eventId: 'a' })
    queue.queueExposure({ ...exposure, eventId: 'b' })
    queue.queueExposure({ ...exposure, eventId: 'c' })

    expect(queue.size().events).toBe(2)
    expect(logger.said('more than 2')).toBe(true)
  })

  it('resolves the endpoint at flush time, not when the queue is built', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 }))
    vi.stubGlobal('fetch', mockFetch)

    let published: string | undefined
    const queue = createEdgeEventQueue({
      sdkKey: VALID_SDK_KEY,
      collectEndpoint: () => published,
      logger: captureLogger(),
    })

    // Queued before the datafile arrived, which is what a hand-built client
    // doing `track()` before `await init()` looks like.
    queue.queueExposure(exposure)
    published = 'https://events.customer.example'

    await queue.flush()

    expect((mockFetch.mock.calls[0] as [string])[0]).toBe(
      'https://events.customer.example/v1/collect/batch',
    )
  })

  it('notifies onError with the events source when a batch is lost', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 })))
    const onError = vi.fn()

    const queue = createEdgeEventQueue({
      sdkKey: VALID_SDK_KEY,
      logger: captureLogger(),
      onError,
      retryAttempts: 0,
    })
    queue.queueExposure(exposure)
    await queue.flush()

    // The EdgeErrorSource union declares 'events'; without this seam it never
    // fired and the docblock promise was false.
    expect(onError).toHaveBeenCalledTimes(1)
    const [error, source] = onError.mock.calls[0] as [Error, string]
    expect(source).toBe('events')
    expect(error.message).toContain('/v1/collect/batch')
  })

  it('does not notify onError when the batch is delivered', async () => {
    const onError = vi.fn()

    const queue = createEdgeEventQueue({
      sdkKey: VALID_SDK_KEY,
      logger: captureLogger(),
      onError,
    })
    queue.queueExposure(exposure)
    await queue.flush()

    expect(onError).not.toHaveBeenCalled()
  })

  it('never rejects when the network throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')))

    const queue = createEdgeEventQueue({
      sdkKey: VALID_SDK_KEY,
      logger: captureLogger(),
      retryAttempts: 0,
    })
    queue.queueExposure(exposure)

    await expect(queue.flush()).resolves.toBeUndefined()
  })
})
