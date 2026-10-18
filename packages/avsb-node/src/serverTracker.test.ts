import { createServerTracker } from './serverTracker'
import type { ServerTrackerOptions, PurchaseOrder } from './serverTracker'
import type { ExposureEvent, MetricEvent } from './types'
import type { FlagDatafile } from '@avsbhq/core'
import { AvsbServer } from './AvsbServer'
import { noopLogger } from './logger'

function makeExposure(overrides: Partial<ExposureEvent> = {}): ExposureEvent {
  return {
    visitorId: 'user-1',
    experimentId: 'exp-1',
    variationId: 'var-1',
    eventName: 'flag_exposure',
    revenue: null,
    timestamp: Date.now(),
    pageUrl: '',
    ...overrides,
  }
}

function makeMetric(overrides: Partial<MetricEvent> = {}): MetricEvent {
  return {
    visitorId: 'user-1',
    eventName: 'purchase',
    revenue: 49.99,
    timestamp: Date.now(),
    pageUrl: '',
    ...overrides,
  }
}

function defaultOptions(overrides: Partial<ServerTrackerOptions> = {}): ServerTrackerOptions {
  return {
    sdkKey: 'test-sdk-key',
    collectEndpoint: 'https://collect.example.com',
    flushInterval: 60_000, // long interval to avoid interference
    batchSize: 10,
    maxQueueSize: 100,
    retryAttempts: 3,
    logger: noopLogger,
    ...overrides,
  }
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>
const originalFetch = global.fetch

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }))
  global.fetch = fetchMock
})

afterEach(() => {
  global.fetch = originalFetch
  vi.useRealTimers()
})

describe('Batching', () => {
  it('queues events and flushes via explicit flush()', async () => {
    const tracker = createServerTracker(defaultOptions())
    tracker.queue(makeExposure())
    tracker.queue(makeExposure({ visitorId: 'user-2' }))

    await tracker.flush()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(body.events).toHaveLength(2)

    await tracker.destroy()
  })

  it('sends exposure events to /v1/collect/batch endpoint', async () => {
    const tracker = createServerTracker(defaultOptions())
    tracker.queue(makeExposure())

    await tracker.flush()

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://collect.example.com/v1/collect/batch'
    )

    await tracker.destroy()
  })

  it('sends metric events to /v1/collect/metric-batch endpoint', async () => {
    const tracker = createServerTracker(defaultOptions())
    tracker.queueMetric(makeMetric())

    await tracker.flush()

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://collect.example.com/v1/collect/metric-batch'
    )

    await tracker.destroy()
  })

  it('resolves immediately when queues are empty', async () => {
    const tracker = createServerTracker(defaultOptions())

    await tracker.flush()

    expect(fetchMock).not.toHaveBeenCalled()

    await tracker.destroy()
  })

  it('splits events into chunks of batchSize', async () => {
    const tracker = createServerTracker(defaultOptions({ batchSize: 3, flushInterval: 999_999 }))

    // Queue 7 events — should produce 3 chunks: [3, 3, 1]
    for (let i = 0; i < 7; i++) {
      tracker.queue(makeExposure({ visitorId: `user-${i}` }))
    }

    // The first 3 trigger an auto-flush (batchSize reached), clear queue.
    // Then events 3-5 trigger another auto-flush at event 5. Event 6 stays queued.
    // We need to wait for the auto-flushes to settle, then call explicit flush.
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    await tracker.flush()

    // Verify all chunks were sent with correct sizes
    const allChunkSizes = fetchMock.mock.calls.map((call) => {
      const body = JSON.parse(call[1]?.body as string)
      return body.events.length
    })
    expect(allChunkSizes.reduce((a: number, b: number) => a + b, 0)).toBe(7)

    await tracker.destroy()
  })

  it('includes sdkKey and correct key name in payload', async () => {
    const tracker = createServerTracker(defaultOptions())
    tracker.queue(makeExposure())
    tracker.queueMetric(makeMetric())

    await tracker.flush()

    expect(fetchMock).toHaveBeenCalledTimes(2)

    const exposureBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(exposureBody.sdkKey).toBe('test-sdk-key')
    expect(exposureBody.events).toBeDefined()
    expect(exposureBody.metricEvents).toBeUndefined()

    const metricBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string)
    expect(metricBody.sdkKey).toBe('test-sdk-key')
    expect(metricBody.metricEvents).toBeDefined()
    expect(metricBody.events).toBeUndefined()

    await tracker.destroy()
  })
})

describe('Auto-flush', () => {
  it('flushes automatically at configured interval', async () => {
    vi.useFakeTimers()

    const tracker = createServerTracker(defaultOptions({ flushInterval: 5_000 }))
    tracker.queue(makeExposure())

    expect(fetchMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(5_000)
    // Let the async flush promise resolve
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    // Clean up: clear interval before destroy to prevent more timer firings
    await tracker.destroy()
  })

  it('triggers flush immediately when batchSize is reached', async () => {
    const tracker = createServerTracker(defaultOptions({ batchSize: 3 }))

    tracker.queue(makeExposure({ visitorId: 'user-1' }))
    tracker.queue(makeExposure({ visitorId: 'user-2' }))
    // No flush yet
    expect(fetchMock).not.toHaveBeenCalled()

    // Third event hits batchSize
    tracker.queue(makeExposure({ visitorId: 'user-3' }))

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(body.events).toHaveLength(3)

    await tracker.destroy()
  })
})

describe('Queue limits', () => {
  it('drops oldest events when maxQueueSize is exceeded', async () => {
    const tracker = createServerTracker(
      defaultOptions({ maxQueueSize: 5, batchSize: 100 })
    )

    // Queue 7 events — first 2 should be dropped
    for (let i = 0; i < 7; i++) {
      tracker.queue(makeExposure({ visitorId: `user-${i}` }))
    }

    await tracker.flush()

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(body.events).toHaveLength(5)
    // Should keep the newest 5 (user-2 through user-6)
    expect(body.events[0].visitorId).toBe('user-2')
    expect(body.events[4].visitorId).toBe('user-6')

    await tracker.destroy()
  })

  it('calls logger.warn when events are dropped', async () => {
    const warnSpy = vi.fn()
    const logger = { ...noopLogger, warn: warnSpy }
    const tracker = createServerTracker(
      defaultOptions({ maxQueueSize: 3, batchSize: 100, logger })
    )

    for (let i = 0; i < 5; i++) {
      tracker.queue(makeExposure({ visitorId: `user-${i}` }))
    }

    expect(warnSpy).toHaveBeenCalled()
    expect(warnSpy.mock.calls[0][0]).toContain('dropping')

    await tracker.destroy()
  })
})

describe('Retry', () => {
  it('retries on failure with exponential backoff', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('network error'))
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const tracker = createServerTracker(defaultOptions({ retryAttempts: 3 }))
    tracker.queue(makeExposure())

    await tracker.flush()

    // Initial attempt + 2 failures + 1 success = 3 calls
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await tracker.destroy()
  })

  it('drops events after max retries exhausted', async () => {
    fetchMock.mockRejectedValue(new Error('network error'))

    const tracker = createServerTracker(defaultOptions({ retryAttempts: 2 }))
    tracker.queue(makeExposure())

    await tracker.flush()

    // Initial attempt + 2 retries = 3 calls
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await tracker.destroy()
  })

  it('calls logger.error after all retries exhausted', async () => {
    fetchMock.mockRejectedValue(new Error('network error'))

    const errorSpy = vi.fn()
    const logger = { ...noopLogger, error: errorSpy }
    const tracker = createServerTracker(
      defaultOptions({ retryAttempts: 1, logger })
    )
    tracker.queue(makeExposure())

    await tracker.flush()

    expect(errorSpy).toHaveBeenCalled()
    expect(errorSpy.mock.calls[0][0]).toContain('Failed to flush')
    expect(errorSpy.mock.calls[0][0]).toContain('after 1 retries')

    await tracker.destroy()
  })
})

describe('Destroy', () => {
  it('flushes remaining events before resolving', async () => {
    const tracker = createServerTracker(defaultOptions())
    tracker.queue(makeExposure())
    tracker.queueMetric(makeMetric())

    expect(fetchMock).not.toHaveBeenCalled()

    await tracker.destroy()

    expect(fetchMock).toHaveBeenCalled()
    // Both exposure and metric batches should have been sent
    const endpoints = fetchMock.mock.calls.map((call) => call[0])
    expect(endpoints).toContain('https://collect.example.com/v1/collect/batch')
    expect(endpoints).toContain('https://collect.example.com/v1/collect/metric-batch')
  })

  it('stops the auto-flush timer', async () => {
    vi.useFakeTimers()

    const tracker = createServerTracker(defaultOptions({ flushInterval: 1_000 }))
    await tracker.destroy()

    // Queue an event after destroy, then advance timers
    // The timer should not fire because destroy cleared it
    tracker.queue(makeExposure()) // no-op after destroy
    vi.advanceTimersByTime(5_000)

    // Only the flush from destroy should have been called (with empty queues, so 0 calls)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('makes queue() a no-op after destroy', async () => {
    const tracker = createServerTracker(defaultOptions())
    await tracker.destroy()

    tracker.queue(makeExposure())
    tracker.queueMetric(makeMetric())

    await tracker.flush()

    // fetch should not have been called since nothing was queued post-destroy
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('Endpoint construction', () => {
  it('constructs correct endpoint from collectEndpoint with trailing slash', async () => {
    const tracker = createServerTracker(
      defaultOptions({ collectEndpoint: 'https://collect.example.com/' })
    )
    tracker.queue(makeExposure())

    await tracker.flush()

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://collect.example.com/v1/collect/batch'
    )

    await tracker.destroy()
  })

  it('constructs correct endpoint from collectEndpoint without trailing slash', async () => {
    const tracker = createServerTracker(
      defaultOptions({ collectEndpoint: 'https://collect.example.com' })
    )
    tracker.queueMetric(makeMetric())

    await tracker.flush()

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://collect.example.com/v1/collect/metric-batch'
    )

    await tracker.destroy()
  })
})

describe('Separate queues', () => {
  it('uses separate queues and endpoints for exposures and metrics', async () => {
    const tracker = createServerTracker(defaultOptions())
    tracker.queue(makeExposure({ visitorId: 'exp-user' }))
    tracker.queueMetric(makeMetric({ visitorId: 'metric-user' }))

    await tracker.flush()

    expect(fetchMock).toHaveBeenCalledTimes(2)

    const call0Url = fetchMock.mock.calls[0][0]
    const call0Body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    const call1Url = fetchMock.mock.calls[1][0]
    const call1Body = JSON.parse(fetchMock.mock.calls[1][1]?.body as string)

    // Exposure call
    expect(call0Url).toBe('https://collect.example.com/v1/collect/batch')
    expect(call0Body.events).toHaveLength(1)
    expect(call0Body.events[0].visitorId).toBe('exp-user')

    // Metric call
    expect(call1Url).toBe('https://collect.example.com/v1/collect/metric-batch')
    expect(call1Body.metricEvents).toHaveLength(1)
    expect(call1Body.metricEvents[0].visitorId).toBe('metric-user')

    await tracker.destroy()
  })

  it('flushes both queues together in a single flush() call', async () => {
    const tracker = createServerTracker(defaultOptions())
    tracker.queue(makeExposure())
    tracker.queue(makeExposure({ visitorId: 'user-2' }))
    tracker.queueMetric(makeMetric())

    await tracker.flush()

    expect(fetchMock).toHaveBeenCalledTimes(2)

    const endpoints = fetchMock.mock.calls.map((call) => call[0])
    expect(endpoints).toContain('https://collect.example.com/v1/collect/batch')
    expect(endpoints).toContain('https://collect.example.com/v1/collect/metric-batch')

    // Verify exposure batch has 2 events
    const exposureCall = fetchMock.mock.calls.find(
      (call) => call[0] === 'https://collect.example.com/v1/collect/batch'
    )
    const exposureBody = JSON.parse(exposureCall![1]?.body as string)
    expect(exposureBody.events).toHaveLength(2)

    // Verify metric batch has 1 event
    const metricCall = fetchMock.mock.calls.find(
      (call) => call[0] === 'https://collect.example.com/v1/collect/metric-batch'
    )
    const metricBody = JSON.parse(metricCall![1]?.body as string)
    expect(metricBody.metricEvents).toHaveLength(1)

    await tracker.destroy()
  })
})

describe('Event identity', () => {
  it('stamps a UUID eventId on an exposure event at enqueue time', async () => {
    const tracker = createServerTracker(defaultOptions())
    tracker.queue(makeExposure({ visitorId: 'id-test-user' }))

    await tracker.flush()

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    const eventId: unknown = body.events[0].eventId
    expect(typeof eventId).toBe('string')
    // UUID v4 format: 8-4-4-4-12 hex groups
    expect(eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    )

    await tracker.destroy()
  })

  it('assigns distinct eventIds to distinct enqueued events', async () => {
    const tracker = createServerTracker(defaultOptions())
    tracker.queue(makeExposure({ visitorId: 'user-a' }))
    tracker.queue(makeExposure({ visitorId: 'user-b' }))
    tracker.queueMetric(makeMetric({ visitorId: 'user-c' }))

    await tracker.flush()

    const exposureBody = JSON.parse(
      fetchMock.mock.calls.find((c) => String(c[0]).includes('/batch') && !String(c[0]).includes('metric'))![1]?.body as string
    )
    const metricBody = JSON.parse(
      fetchMock.mock.calls.find((c) => String(c[0]).includes('metric-batch'))![1]?.body as string
    )

    const idA: unknown = exposureBody.events[0].eventId
    const idB: unknown = exposureBody.events[1].eventId
    const idC: unknown = metricBody.metricEvents[0].eventId

    expect(typeof idA).toBe('string')
    expect(typeof idB).toBe('string')
    expect(typeof idC).toBe('string')
    expect(idA).not.toBe(idB)
    expect(idA).not.toBe(idC)
    expect(idB).not.toBe(idC)

    await tracker.destroy()
  })

  it('sends the same eventId on every retry attempt (5xx triggers retry)', async () => {
    // First two attempts return 500; third succeeds.
    fetchMock
      .mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockResolvedValueOnce(new Response('error', { status: 500 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const tracker = createServerTracker(defaultOptions({ retryAttempts: 3 }))
    tracker.queue(makeExposure({ visitorId: 'retry-user' }))

    await tracker.flush()

    // Should have been called 3 times total (2 failures + 1 success)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // Extract eventId from each attempt's body
    const ids = fetchMock.mock.calls.map((call) => {
      const body = JSON.parse(call[1]?.body as string)
      return body.events[0].eventId as unknown
    })

    // All three attempts must carry the exact same eventId — that is the
    // dedup guarantee: a stable id survives retries unchanged.
    expect(typeof ids[0]).toBe('string')
    expect(ids[0]).toBe(ids[1])
    expect(ids[1]).toBe(ids[2])

    await tracker.destroy()
  })
})

// ---------------------------------------------------------------------------
// trackPurchase — sends immediately to /v1/collect/orders
// ---------------------------------------------------------------------------

describe('trackPurchase', () => {
  const ORDERS_ENDPOINT = 'https://collect.example.com/v1/collect/orders'
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  function makeOrder(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
    return { orderId: 'ord_test_001', total: 99.99, ...overrides }
  }

  it('sends to /v1/collect/orders with sdkKey and correct payload shape', async () => {
    const tracker = createServerTracker(defaultOptions())

    await tracker.trackPurchase('user-p1', makeOrder())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(ORDERS_ENDPOINT)

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(body.sdkKey).toBe('test-sdk-key')
    expect(body.orders).toHaveLength(1)

    const order = body.orders[0]
    expect(order.orderId).toBe('ord_test_001')
    expect(order.total).toBe(99.99)
    expect(order.visitorId).toBe('user-p1')
    expect(typeof order.eventId).toBe('string')
    expect(order.eventId).toMatch(UUID_RE)
    expect(typeof order.timestamp).toBe('number')

    await tracker.destroy()
  })

  it('passes decimal total through without modification', async () => {
    const tracker = createServerTracker(defaultOptions())

    await tracker.trackPurchase('user-p2', makeOrder({ orderId: 'ord_decimal', total: 123.456 }))

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(body.orders[0].total).toBe(123.456)

    await tracker.destroy()
  })

  it('includes optional fields in the payload when provided', async () => {
    const tracker = createServerTracker(defaultOptions())

    await tracker.trackPurchase('user-p3', {
      orderId: 'ord_full',
      total: 200.00,
      currency: 'EUR',
      subtotal: 180.00,
      shipping: 10.00,
      tax: 10.00,
      discount: 5.00,
      coupon: 'SAVE10',
      items: [{ sku: 'SKU-1', name: 'Widget', price: 90.00, quantity: 2, category: 'Gadgets' }],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    const order = body.orders[0]
    expect(order.currency).toBe('EUR')
    expect(order.subtotal).toBe(180.00)
    expect(order.shipping).toBe(10.00)
    expect(order.tax).toBe(10.00)
    expect(order.discount).toBe(5.00)
    expect(order.coupon).toBe('SAVE10')
    expect(order.items).toHaveLength(1)
    expect(order.items[0].sku).toBe('SKU-1')

    await tracker.destroy()
  })

  it('threads test:true to the wire payload for a test purchase (§B17)', async () => {
    const tracker = createServerTracker(defaultOptions())

    await tracker.trackPurchase('user-test', makeOrder({ orderId: 'ord_test', test: true }))

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    expect(body.orders[0].test).toBe(true)

    await tracker.destroy()
  })

  it('omits the test field for a normal order', async () => {
    const tracker = createServerTracker(defaultOptions())

    await tracker.trackPurchase('user-real', makeOrder({ orderId: 'ord_real' }))

    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string)
    // JSON.stringify drops undefined, so a normal order carries no `test` key.
    expect('test' in body.orders[0]).toBe(false)

    await tracker.destroy()
  })

  it('fires independently of the exposure/metric batch queues', async () => {
    const tracker = createServerTracker(defaultOptions())

    // Queue an exposure but don't flush
    tracker.queue({
      visitorId: 'user-q',
      experimentId: 'exp-1',
      variationId: 'var-1',
      eventName: 'flag_exposure',
      revenue: null,
      timestamp: Date.now(),
      pageUrl: '',
    })

    // trackPurchase fires immediately
    await tracker.trackPurchase('user-p4', makeOrder({ orderId: 'ord_independent' }))

    // Only the purchase call should have gone out so far (not the queued exposure)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(ORDERS_ENDPOINT)

    await tracker.destroy()
  })

  it('assigns a distinct eventId per call', async () => {
    const tracker = createServerTracker(defaultOptions())

    await tracker.trackPurchase('user-pa', makeOrder({ orderId: 'ord_a' }))
    await tracker.trackPurchase('user-pb', makeOrder({ orderId: 'ord_b' }))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const idA = JSON.parse(fetchMock.mock.calls[0][1]?.body as string).orders[0].eventId
    const idB = JSON.parse(fetchMock.mock.calls[1][1]?.body as string).orders[0].eventId
    expect(typeof idA).toBe('string')
    expect(typeof idB).toBe('string')
    expect(idA).not.toBe(idB)

    await tracker.destroy()
  })

  it('is a no-op after destroy()', async () => {
    const tracker = createServerTracker(defaultOptions())
    await tracker.destroy()

    await tracker.trackPurchase('user-destroyed', makeOrder())

    // destroy() itself calls flush() with empty queues → 0 fetch calls
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('constructs correct endpoint from collectEndpoint with trailing slash', async () => {
    const tracker = createServerTracker(
      defaultOptions({ collectEndpoint: 'https://collect.example.com/' })
    )

    await tracker.trackPurchase('user-ep', makeOrder())

    expect(fetchMock.mock.calls[0][0]).toBe(ORDERS_ENDPOINT)

    await tracker.destroy()
  })
})

// Integration test: AvsbServer.getFlag → evaluateFlag → serverTracker.queue →
// serverTracker.flush → fetch payload. Locks the avsb-node serialisation path
// against silent regressions in attribute pass-through.
describe('Attribute pass-through (integration with AvsbServer)', () => {
  function makeAbDatafileWithAttributes(registered: string[]): FlagDatafile {
    return {
      version: 1,
      projectType: 'FEATURE_FLAG',
      sdkKey: 'test-sdk-key',
      environmentKey: 'test',
      publishedAt: '2024-01-01T00:00:00.000Z',
      collectEndpoint: 'https://collect.example.com',
      flags: [
        {
          id: 'flag-1',
          key: 'ab-flag',
          type: 'string',
          enabled: true,
          defaultVariationId: 'var-a',
          variations: [
            { id: 'var-a', key: 'variation-a', value: 'a' },
            { id: 'var-b', key: 'variation-b', value: 'b' },
          ],
          overrides: [],
          rules: [
            {
              id: 'rule-ab-1',
              type: 'ab_test',
              enabled: true,
              audienceIds: [],
              hashAttribute: 'userId',
              trafficAllocation: 1,
              variations: [
                { variationId: 'var-a', percentage: 0.5 },
                { variationId: 'var-b', percentage: 0.5 },
              ],
            },
          ],
        },
      ],
      audiences: [],
      registeredAttributes: registered,
    }
  }

  it('forwards registered attributes end-to-end and drops unregistered keys', async () => {
    // fetchMock is the global mock from beforeEach — already returns 200 OK.
    const datafile = makeAbDatafileWithAttributes(['plan', 'country'])

    const server = new AvsbServer({
      sdkKey: 'test-sdk-key',
      pollingInterval: 300_000,
      initTimeout: 5000,
      bootstrap: datafile,
      events: { flushInterval: 999_999, batchSize: 100 },
      logger: noopLogger,
    })
    await server.onReady()

    // The context is the THIRD argument itself, not an options bag wrapping it.
    // Wrapped, it reaches the evaluator with no `kind` and no `key`: the exposure
    // then carries an empty visitor id and no attributes at all.
    server.getFlag('ab-flag', undefined, {
      kind: 'user',
      key: 'user-2',
      plan: 'pro',
      country: 'US',
      // Unregistered keys must be dropped at the SDK boundary:
      password: 'sekret',
      email: 'a@b.com',
    })

    await server.flush()

    // The first call to fetchMock should be the exposure batch POST.
    const exposureCall = fetchMock.mock.calls.find(
      (call) => call[0] === 'https://collect.example.com/v1/collect/batch'
    )
    expect(exposureCall).toBeDefined()
    const body = JSON.parse(exposureCall![1]?.body as string)
    expect(body.events).toHaveLength(1)
    expect(body.events[0].experimentId).toBe('rule-ab-1')
    expect(body.events[0].attributes).toEqual({ plan: 'pro', country: 'US' })

    await server.close()
  })
})
