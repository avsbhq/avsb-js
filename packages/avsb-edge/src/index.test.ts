// =====================================================================
// index.ts — the public surface of @avsbhq/edge.
//
// These are contract assertions, not smoke tests: every name below is
// documented in the README and is launch-final, so a rename has to break a
// test before it breaks a customer.
// =====================================================================

import { describe, it, expect } from 'vitest'
import {
  AvsbEdgeClient,
  MAX_BATCH_ITEMS,
  SDK_TYPE,
  VISITOR_COOKIE_NAME,
  VISITOR_HEADER_NAME,
  buildExposureBatchBody,
  buildHeartbeatBody,
  buildMetricBatchBody,
  datafileRequestUrl,
  evaluateFlagEdge,
  fetchDatafileFromCdn,
  generateEventId,
  getAllFlagsEdge,
  parseCookieHeader,
  readVisitorId,
  validateSdkKeyShape,
} from './index'
import { VALID_SDK_KEY } from './fixtures'

describe('@avsbhq/edge public surface', () => {
  it('exports the client with the documented method names', () => {
    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logLevel: 'silent' })

    for (const method of [
      'init',
      'getInitResult',
      'isReady',
      'getDatafile',
      'getContext',
      'getFlag',
      'getBoolFlag',
      'getStringFlag',
      'getNumberFlag',
      'getJsonFlag',
      'getAllFlags',
      'track',
      'flushEvents',
      'queueSize',
    ] as const) {
      expect(typeof client[method]).toBe('function')
    }
  })

  it('exports the evaluation primitives for callers who own the lifecycle', () => {
    expect(typeof evaluateFlagEdge).toBe('function')
    expect(typeof getAllFlagsEdge).toBe('function')
    expect(typeof fetchDatafileFromCdn).toBe('function')
    expect(datafileRequestUrl(VALID_SDK_KEY)).toContain('/datafile.json')
  })

  it('exports the wire builders the conformance harness asserts against', () => {
    expect(buildExposureBatchBody(VALID_SDK_KEY, []).events).toEqual([])
    expect(buildMetricBatchBody(VALID_SDK_KEY, []).metricEvents).toEqual([])
    expect(buildHeartbeatBody(VALID_SDK_KEY).sdkType).toBe(SDK_TYPE)
    expect(MAX_BATCH_ITEMS).toBe(100)
    expect(typeof generateEventId()).toBe('string')
  })

  it('exports the identity helpers a custom contextFrom is built from', () => {
    expect(VISITOR_HEADER_NAME).toBe('x-avsb-visitor-id')
    expect(VISITOR_COOKIE_NAME).toBe('_avsb_visitor')
    expect(parseCookieHeader('a=1')).toEqual({ a: '1' })
    expect(readVisitorId(undefined)).toBeNull()
  })

  it('exports key validation so a caller can check a key before constructing', () => {
    expect(validateSdkKeyShape(VALID_SDK_KEY).valid).toBe(true)
    expect(validateSdkKeyShape('sdk-prod-xxx').valid).toBe(false)
  })
})
