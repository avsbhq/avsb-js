// =====================================================================
// AvsbEdgeClient — diagnostics: the onError contract, the identity warning
// on track(), and when the collect endpoint is resolved.
//
// Split from AvsbEdgeClient.events.test.ts, which pins the wire shape.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EvalContext } from '@avsbhq/core'
import { AvsbEdgeClient } from './AvsbEdgeClient'
import { resetLogOnce } from './logger'
import { VALID_SDK_KEY, captureLogger, fetchCallTo, jsonResponse, testDatafile } from './fixtures'

const userCtx: EvalContext = { kind: 'user', key: 'user_42' }

beforeEach(() => {
  resetLogOnce()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('onError coverage across every EdgeErrorSource member', () => {
  it('fires with source "events" when a batch cannot be delivered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, { status: 500 })))
    const onError = vi.fn()

    const c = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      context: userCtx,
      logLevel: 'silent',
      onError,
      eventRetryAttempts: 0,
    })
    await c.init()
    c.getFlag('checkout-v2', false)
    await c.flushEvents()

    expect(onError.mock.calls.map((call) => (call as [Error, string])[1])).toContain('events')
  })

  it('fires with source "heartbeat" when liveness cannot be reported', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(testDatafile))
        .mockRejectedValue(new Error('heartbeat host down')),
    )
    const onError = vi.fn()

    const c = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logLevel: 'silent', onError })
    await c.init()
    await c.flushEvents()

    expect(onError.mock.calls.map((call) => (call as [Error, string])[1])).toContain('heartbeat')
  })

  it('leaves a failed heartbeat out of the warn stream, since it is cosmetic', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(testDatafile))
        .mockRejectedValue(new Error('heartbeat host down')),
    )
    const logger = captureLogger()

    const c = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logger })
    await c.init()
    await c.flushEvents()

    // A missed heartbeat moves a dashboard badge, not a visitor's experience.
    expect(logger.messages('warn')).toHaveLength(0)
    expect(logger.said('heartbeat send failed')).toBe(true)
  })
})

describe('track with no identity', () => {
  it('warns rather than queueing an unattributable event silently', async () => {
    const logger = captureLogger()
    const c = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      logger,
    })
    await c.init()

    c.track('signup_completed')

    // An event with no visitor can never join an exposure in results.
    expect(logger.said('no visitor identity')).toBe(true)
  })

  it('still queues the event, so nothing is dropped on top of the warning', async () => {
    const c = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      logLevel: 'silent',
    })
    await c.init()

    c.track('signup_completed')

    expect(c.queueSize().metricEvents).toBe(1)
  })

  it('says nothing when the bound context carries a real key', async () => {
    const logger = captureLogger()
    const c = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      context: userCtx,
      logger,
    })
    await c.init()

    c.track('signup_completed')

    expect(logger.said('no visitor identity')).toBe(false)
  })
})

describe('collect endpoint resolution timing', () => {
  it('honours a self-hosted origin for events tracked before init finished', async () => {
    const selfHosted = { ...testDatafile, collectEndpoint: 'https://events.customer.example' }
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(selfHosted))
    vi.stubGlobal('fetch', mockFetch)

    const c = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      context: userCtx,
      logLevel: 'silent',
      heartbeat: false,
    })

    // Tracked BEFORE the datafile lands. Snapshotting the endpoint here would
    // pin the public ingest default for the whole request.
    c.track('signup_completed')
    await c.init()
    await c.flushEvents()

    expect(fetchCallTo('/v1/collect/metric-batch')[0]).toBe(
      'https://events.customer.example/v1/collect/metric-batch',
    )
  })
})
