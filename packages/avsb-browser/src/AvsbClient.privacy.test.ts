// `_meta.privateAttributes` promises the named values never leave on an
// exposure (@avsbhq/core types.ts §2.1). Two ways that promise can be broken:
//
//   1. Not redacting at all. This client used to queue, emit, and forward the
//      raw exposure straight from the evaluator.
//   2. Redacting against the WRONG context. `getAllFlags({ context })`
//      evaluates a caller-supplied context, so deriving the private set from
//      the bound one leaves the requested context's attributes exposed.
//
// The exposure's `attributes` map is the field that carries them, and only
// keys in the datafile's `registeredAttributes` are emitted at all, so these
// fixtures register both.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExposureEvent, FlagDatafile } from '@avsbhq/core'
import { AvsbClient } from './AvsbClient'
import type { Tracker } from './types'
import * as trackerModule from './tracker'

const DATAFILE: FlagDatafile = {
  version: 2,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk_production_privacytest0001',
  environmentKey: 'production',
  publishedAt: '2026-05-28T00:00:00.000Z',
  collectEndpoint: 'https://collect.test',
  registeredAttributes: ['plan', 'email'],
  flags: [
    {
      id: 'flag1',
      key: 'checkout-v2',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var_off',
      variations: [
        { id: 'var_off', key: 'off', value: false },
        { id: 'var_on', key: 'on', value: true },
      ],
      overrides: [],
      rules: [
        {
          id: 'rule1',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [{ variationId: 'var_on', percentage: 1 }],
        },
      ],
    },
  ],
  audiences: [],
}

function makeTrackerSpy(): { tracker: Tracker; queueMock: ReturnType<typeof vi.fn> } {
  const queueMock = vi.fn()
  const tracker: Tracker = {
    queue: queueMock,
    queueMetric: vi.fn(),
    flush: vi.fn(),
    destroy: vi.fn(),
  }
  return { tracker, queueMock }
}

function newClient(): AvsbClient {
  return new AvsbClient({
    sdkKey: DATAFILE.sdkKey,
    bootstrap: DATAFILE,
    autoRefresh: false,
    cache: false,
    context: {
      kind: 'user',
      key: 'u_bound',
      plan: 'pro',
      email: 'bound@example.com',
      _meta: { privateAttributes: ['email'] },
    },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('exposure redaction', () => {
  it('strips the bound context private attribute from a queued exposure', async () => {
    const { tracker, queueMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
    const client = newClient()
    await client.onReady()

    client.getBoolFlag('checkout-v2', false)

    expect(queueMock).toHaveBeenCalledTimes(1)
    const event = queueMock.mock.calls[0][0] as ExposureEvent
    expect(event.attributes).not.toHaveProperty('email')
    expect(event.attributes).toMatchObject({ plan: 'pro' })
    expect(JSON.stringify(event)).not.toContain('bound@example.com')

    await client.close()
  })

  it('redacts against the REQUESTED context, not the bound one', async () => {
    // getAllFlags evaluates the context it was handed, so its exposures carry
    // that context's attributes, and its private list is the one that applies.
    const { tracker, queueMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
    const client = newClient()
    await client.onReady()

    client.getAllFlags({
      fireExposures: true,
      context: {
        kind: 'user',
        key: 'u_requested',
        plan: 'free',
        email: 'requested@example.com',
        _meta: { privateAttributes: ['email'] },
      },
    })

    expect(queueMock).toHaveBeenCalledTimes(1)
    const event = queueMock.mock.calls[0][0] as ExposureEvent
    expect(event.visitorId).toBe('u_requested')
    expect(event.attributes).not.toHaveProperty('email')
    expect(event.attributes).toMatchObject({ plan: 'free' })
    expect(JSON.stringify(event)).not.toContain('requested@example.com')

    await client.close()
  })

  it('redacts the exposure handed to a bus subscriber too', async () => {
    const { tracker } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
    const client = newClient()
    await client.onReady()

    const seen: ExposureEvent[] = []
    client.on('exposure', (event) => seen.push(event))

    client.getBoolFlag('checkout-v2', false)

    expect(seen).toHaveLength(1)
    expect(seen[0].attributes).not.toHaveProperty('email')

    await client.close()
  })

  it('leaves attributes intact when the context declares nothing private', async () => {
    const { tracker, queueMock } = makeTrackerSpy()
    vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
    const client = new AvsbClient({
      sdkKey: DATAFILE.sdkKey,
      bootstrap: DATAFILE,
      autoRefresh: false,
      cache: false,
      context: { kind: 'user', key: 'u_open', plan: 'pro', email: 'open@example.com' },
    })
    await client.onReady()

    client.getBoolFlag('checkout-v2', false)

    const event = queueMock.mock.calls[0][0] as ExposureEvent
    expect(event.attributes).toMatchObject({
      plan: 'pro',
      email: 'open@example.com',
    })

    await client.close()
  })
})
