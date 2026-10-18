// @vitest-environment node
//
// The edge SDK runs on servers, never in a browser. Under the default DOM test
// environment `location` exists, so the evaluator stamps the test page's URL on
// every exposure and the client's own request-URL fill-in never runs; on a real
// edge runtime there is no `location` at all.
// =====================================================================
// AvsbEdgeClient — event delivery end to end (B7).
//
// This is the file that would have caught the deleted bug: the old client
// POSTed `{sdkKey, events: [{eventKey, context, value, properties,
// timestamp}]}` to the bare collectEndpoint with no path and no eventIds, a
// shape the ingestion worker rejects. The assertions below are on exact
// field names and the exact URL.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EvalContext } from '@avsbhq/core'
import { AvsbEdgeClient } from './AvsbEdgeClient'
import { resetLogOnce } from './logger'
import type { CapturingLogger } from './fixtures'
import {
  VALID_SDK_KEY,
  captureLogger,
  fetchCallTo,
  fetchCalls,
  jsonBodyOf,
  jsonResponse,
  makeStorage,
  testDatafile,
} from './fixtures'

const userCtx: EvalContext = { kind: 'user', key: 'user_42' }

interface ExposureBatch {
  sdkKey: string
  events: Array<Record<string, unknown>>
}

interface MetricBatch {
  sdkKey: string
  metricEvents: Array<Record<string, unknown>>
}

function client(logger?: CapturingLogger): AvsbEdgeClient {
  return new AvsbEdgeClient({
    sdkKey: VALID_SDK_KEY,
    datafile: testDatafile,
    context: userCtx,
    logger,
    logLevel: logger ? undefined : 'silent',
  })
}

beforeEach(() => {
  resetLogOnce()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------
// Exposure batch
// ---------------------------------------------------------------------

describe('flushEvents — exposure batch', () => {
  it('posts to {collectEndpoint}/v1/collect/batch, not the bare endpoint', async () => {
    const c = client()
    await c.init()
    c.getFlag('checkout-v2', false)

    await c.flushEvents()

    const [url, init] = fetchCallTo('/v1/collect')
    expect(url).toBe('https://collect.test.invalid/v1/collect/batch')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('carries sdkKey in the body envelope', async () => {
    const c = client()
    await c.init()
    c.getFlag('checkout-v2', false)
    await c.flushEvents()

    // The collect paths are shared by every key, so the key rides in the body.
    expect(jsonBodyOf<ExposureBatch>(fetchCallTo('/v1/collect/batch')).sdkKey).toBe(VALID_SDK_KEY)
  })

  it('emits exactly the locked field names on each event', async () => {
    const c = client()
    await c.init()
    c.getFlag('checkout-v2', false)
    await c.flushEvents()

    const [event] = jsonBodyOf<ExposureBatch>(fetchCallTo('/v1/collect/batch')).events

    expect(Object.keys(event).sort()).toEqual([
      'eventId',
      'eventName',
      'experimentId',
      'pageUrl',
      'properties',
      'revenue',
      'timestamp',
      'variationId',
      'visitorId',
    ])
    expect(event.eventName).toBe('flag_exposure')
    expect(event.experimentId).toBe('rule_ab_split')
    expect(event.variationId).toBe('var_treatment')
    expect(event.visitorId).toBe('user_42')
    expect(event.revenue).toBeNull()
    expect(typeof event.timestamp).toBe('number')
    expect(event.pageUrl).toBe('')
    expect(event.properties).toEqual({ flagKey: 'checkout-v2', flagId: 'flag_ab' })
  })

  it('never emits the deleted bespoke fields', async () => {
    const c = client()
    await c.init()
    c.getFlag('checkout-v2', false)
    await c.flushEvents()

    const [event] = jsonBodyOf<ExposureBatch>(fetchCallTo('/v1/collect/batch')).events

    expect(event.eventKey).toBeUndefined()
    expect(event.context).toBeUndefined()
  })

  it('stamps an eventId on every event', async () => {
    const c = client()
    await c.init()
    c.getFlag('checkout-v2', false)
    await c.flushEvents()

    const [event] = jsonBodyOf<ExposureBatch>(fetchCallTo('/v1/collect/batch')).events

    expect(typeof event.eventId).toBe('string')
    expect(String(event.eventId).length).toBeGreaterThan(0)
  })

  it('re-sends identical eventIds on a retry so ingestion deduplicates', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, { status: 502 }))
        .mockResolvedValue(jsonResponse({ accepted: 1 })),
    )

    const c = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      context: userCtx,
      logLevel: 'silent',
      eventRetryAttempts: 1,
    })
    await c.init()
    c.getFlag('checkout-v2', false)
    await c.flushEvents()

    const attempts = fetchCalls().filter(([url]) => url.includes('/v1/collect/batch'))
    expect(attempts).toHaveLength(2)
    expect(attempts[1][1].body).toBe(attempts[0][1].body)
  })
})

// ---------------------------------------------------------------------
// Metric batch
// ---------------------------------------------------------------------

describe('flushEvents — tracked events', () => {
  it('posts tracked events to /v1/collect/metric-batch', async () => {
    const c = client()
    await c.init()
    c.track('signup_completed')

    await c.flushEvents()

    expect(fetchCallTo('/v1/collect/metric-batch')[0]).toBe(
      'https://collect.test.invalid/v1/collect/metric-batch',
    )
  })

  it('emits exactly the locked metric field names', async () => {
    const c = client()
    await c.init()
    c.track('signup_completed')
    await c.flushEvents()

    const [event] = jsonBodyOf<MetricBatch>(fetchCallTo('/v1/collect/metric-batch')).metricEvents

    expect(Object.keys(event).sort()).toEqual([
      'eventId',
      'eventName',
      'pageUrl',
      'revenue',
      'timestamp',
      'value',
      'visitorId',
    ])
    expect(event.eventName).toBe('signup_completed')
    expect(event.visitorId).toBe('user_42')
    // A plain count carries neither number, and says so explicitly rather
    // than leaving the reader to guess which column was meant.
    expect(event.revenue).toBeNull()
    expect(event.value).toBeNull()
  })

  it('sends payload.revenue in the revenue column and nothing in value', async () => {
    const c = client()
    await c.init()
    c.track('purchase', { revenue: 49.99 })
    await c.flushEvents()

    const [event] = jsonBodyOf<MetricBatch>(fetchCallTo('/v1/collect/metric-batch')).metricEvents

    expect(event.revenue).toBe(49.99)
    expect(event.value).toBeNull()
  })

  it('sends payload.value in the SEPARATE value column, never as money', async () => {
    const c = client()
    await c.init()
    c.track('items_added', { value: 3 })
    await c.flushEvents()

    const [event] = jsonBodyOf<MetricBatch>(fetchCallTo('/v1/collect/metric-batch')).metricEvents

    // B36: this used to land in `revenue`, which recorded a quantity as money
    // and left every average-value metric empty.
    expect(event.value).toBe(3)
    expect(event.revenue).toBeNull()
  })

  it('carries money and a quantity on one conversion', async () => {
    const c = client()
    await c.init()
    c.track('checkout_completed', { revenue: 99.5, value: 2 })
    await c.flushEvents()

    const [event] = jsonBodyOf<MetricBatch>(fetchCallTo('/v1/collect/metric-batch')).metricEvents

    expect(event.revenue).toBe(99.5)
    expect(event.value).toBe(2)
  })

  it('drops properties and says so, naming value as the place for a number', async () => {
    const logger = captureLogger()
    const c = client(logger)
    await c.init()
    c.track('purchase', { value: 1, properties: { sku: 'SKU-1' } })
    await c.flushEvents()

    const [event] = jsonBodyOf<MetricBatch>(fetchCallTo('/v1/collect/metric-batch')).metricEvents

    // The metric batch body has no properties field, so anything sent under
    // that name is stripped server-side: it would look delivered and be gone.
    expect(event.properties).toBeUndefined()
    const warning = logger.messages('warn').join('\n')
    expect(warning).toContain('purchase')
    expect(warning).toContain('`value`')
  })

  it('attributes a tracked event to the context passed on the payload', async () => {
    const c = client()
    await c.init()
    c.track('signup_completed', { context: { kind: 'user', key: 'user_99' } })
    await c.flushEvents()

    const [event] = jsonBodyOf<MetricBatch>(fetchCallTo('/v1/collect/metric-batch')).metricEvents

    expect(event.visitorId).toBe('user_99')
  })

  it('resolves the visitor of a multi-context through its user sub-context', async () => {
    const c = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      context: {
        kind: 'multi',
        user: { kind: 'user', key: 'user_42' },
        organization: { kind: 'organization', key: 'org_1' },
      },
      logLevel: 'silent',
    })
    await c.init()
    c.track('signup_completed')
    await c.flushEvents()

    const [event] = jsonBodyOf<MetricBatch>(fetchCallTo('/v1/collect/metric-batch')).metricEvents

    // Same id the evaluator buckets on, so an exposure and a conversion from
    // one request join.
    expect(event.visitorId).toBe('user_42')
  })

  it('sends events even when the datafile carries no collectEndpoint', async () => {
    const c = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: { ...testDatafile, collectEndpoint: '' },
      context: userCtx,
      logLevel: 'silent',
    })
    await c.init()
    c.track('signup_completed')
    await c.flushEvents()

    // The old client silently emptied the queue in this case. The endpoint
    // contract's default host means the events still land. This is the ONE
    // assertion here that names the default rather than the datafile's own
    // endpoint, because emptying that field is the whole point of the case.
    expect(fetchCallTo('/v1/collect/metric-batch')[0]).toBe(
      'https://ingest.avsb.cloud/v1/collect/metric-batch',
    )
  })
})

// ---------------------------------------------------------------------
// Flush lifecycle
// ---------------------------------------------------------------------

describe('flushEvents lifecycle', () => {
  it('is a no-op with nothing queued and nothing deferred', async () => {
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    const c = client()
    await c.init()
    await c.flushEvents()

    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('sends both batches in one flush', async () => {
    const c = client()
    await c.init()
    c.getFlag('checkout-v2', false)
    c.track('signup_completed')

    await c.flushEvents()

    expect(fetchCalls().map(([url]) => url).sort()).toEqual([
      'https://collect.test.invalid/v1/collect/batch',
      'https://collect.test.invalid/v1/collect/metric-batch',
    ])
  })

  it('never rejects when the ingest host is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const c = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      context: userCtx,
      logLevel: 'silent',
      eventRetryAttempts: 0,
    })
    await c.init()
    c.getFlag('checkout-v2', false)

    await expect(c.flushEvents()).resolves.toBeUndefined()
  })

  it('awaits deferred cache writes on a runtime with no waitUntil', async () => {
    let resolveWrite = (): void => {}
    const writePromise = new Promise<void>((resolve) => {
      resolveWrite = resolve
    })
    const storage = makeStorage({ datafileSet: vi.fn().mockReturnValue(writePromise) })

    const c = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      storage,
      logLevel: 'silent',
      heartbeat: false,
    })
    await c.init()

    let settled = false
    const flush = c.flushEvents().then(() => {
      settled = true
    })

    // Without the deferred list, a Lambda@Edge or Fastly invocation would
    // return before the cache write finished and cancel it.
    await Promise.resolve()
    expect(settled).toBe(false)
    resolveWrite()
    await flush
    expect(settled).toBe(true)
  })

  it('reports queue depths for diagnostics', async () => {
    const c = client()
    await c.init()

    expect(c.queueSize()).toEqual({ events: 0, metricEvents: 0 })
    c.getFlag('checkout-v2', false)
    c.track('signup_completed')
    expect(c.queueSize()).toEqual({ events: 1, metricEvents: 1 })
  })
})
