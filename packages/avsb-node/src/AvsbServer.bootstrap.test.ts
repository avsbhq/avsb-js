// Bootstrap handoff, pre-ready queueing symmetry, and the key-shape check.
// These are the WS2 item 5 behaviours that had no coverage because they did not
// exist: `applyDatafileBootstrap` was a comment inside the utils adapter,
// `track` queued while `trackPurchase` warned and dropped, and a bad SDK key
// produced silence.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlagDatafile, Logger } from '@avsbhq/core'
import { AvsbServer } from './AvsbServer'
import type { AvsbServerOptions } from './types'

const SDK_KEY = 'sdk_production_bootstraptest01'

function makeDatafile(overrides: Partial<FlagDatafile> = {}): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
    publishedAt: '2026-05-28T00:00:00.000Z',
    collectEndpoint: 'https://collect.test.invalid',
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
            type: 'targeted_delivery',
            enabled: true,
            audienceIds: [],
            hashAttribute: 'userId',
            trafficAllocation: null,
            variations: [{ variationId: 'var_on', percentage: 1 }],
          },
        ],
      },
    ],
    audiences: [],
    ...overrides,
  }
}

function makeLogger(): Logger & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = { debug: [], info: [], warn: [], error: [] }
  return {
    calls,
    debug(...args: unknown[]) {
      calls.debug.push(args)
    },
    info(...args: unknown[]) {
      calls.info.push(args)
    },
    warn(...args: unknown[]) {
      calls.warn.push(args)
    },
    error(...args: unknown[]) {
      calls.error.push(args)
    },
    child() {
      return this
    },
  }
}

function makeOptions(overrides: Partial<AvsbServerOptions> = {}): AvsbServerOptions {
  return {
    sdkKey: SDK_KEY,
    pollingInterval: 300_000,
    streaming: false,
    logLevel: 'silent',
    ...overrides,
  }
}

function okFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('{}', { status: 200 }))
  global.fetch = fetchMock
  return fetchMock as unknown as ReturnType<typeof vi.fn>
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AvsbServer key-shape validation', () => {
  it('logs an actionable error for a key that is not shaped like an SDK key', () => {
    const logger = makeLogger()
    new AvsbServer(makeOptions({ sdkKey: 'test-sdk-key', logger }))

    expect(logger.calls.error).toHaveLength(1)
    const message = String(logger.calls.error[0][0])
    expect(message).toContain('does not look like an SDK key')
    expect(message).toContain('sdk_<environment>_<id>')
    expect(message).toContain('Environments')
  })

  it('says nothing for a well-shaped key', () => {
    const logger = makeLogger()
    new AvsbServer(makeOptions({ logger }))
    expect(logger.calls.error).toHaveLength(0)
  })

  it('never throws, because an unrecognised key may still be valid', () => {
    expect(() => new AvsbServer(makeOptions({ sdkKey: 'nonsense' }))).not.toThrow()
  })
})

describe('AvsbServer.applyDatafileBootstrap', () => {
  it('makes the SDK ready without any network request', () => {
    const fetchMock = okFetch()
    const server = new AvsbServer(makeOptions())

    server.applyDatafileBootstrap(makeDatafile())

    expect(server.isReady()).toBe(true)
    expect(server.getBoolFlag('checkout-v2', false, { kind: 'user', key: 'u_1' }).value).toBe(
      true
    )
    // No datafile fetch: this is the serverless cold-start path.
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('datafile.json'))
    ).toHaveLength(0)
  })

  it('exposes the applied datafile through getDatafile', () => {
    okFetch()
    const server = new AvsbServer(makeOptions())
    const datafile = makeDatafile()

    expect(server.getDatafile()).toBeNull()
    server.applyDatafileBootstrap(datafile)
    expect(server.getDatafile()).toBe(datafile)
  })

  it('emits ready once, so a consumer awaiting onReady resolves as a bootstrap', async () => {
    okFetch()
    const server = new AvsbServer(makeOptions())
    const readySpy = vi.fn()
    server.on('ready', readySpy)

    server.applyDatafileBootstrap(makeDatafile())

    expect(readySpy).toHaveBeenCalledTimes(1)
    await expect(server.onReady()).resolves.toEqual({
      success: true,
      source: 'bootstrap',
    })
    await server.close()
  })

  it('emits configUpdate with reason "manual" when a later datafile is handed over', () => {
    okFetch()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    const updates: Array<{ publishedAt: string; reason: string }> = []
    server.on('configUpdate', (data) => updates.push(data))

    server.applyDatafileBootstrap(
      makeDatafile({ publishedAt: '2026-06-01T00:00:00.000Z' })
    )

    expect(updates).toEqual([
      { publishedAt: '2026-06-01T00:00:00.000Z', reason: 'manual' },
    ])
  })

  it('is reachable through client.utils.hydrateBootstrap for a blob with a datafile', () => {
    okFetch()
    const server = new AvsbServer(makeOptions())

    const result = server.utils.hydrateBootstrap({
      format: 'avsb-bootstrap-v1',
      snapshot: {
        capturedAt: Date.now(),
        datafileVersion: '2026-05-28T00:00:00.000Z',
        flags: {},
        contextSummary: [],
      },
      datafile: makeDatafile(),
      producedAt: Date.now(),
    })

    expect(result.datafileApplied).toBe(true)
    expect(result.snapshotApplied).toBe(false)
    expect(server.isReady()).toBe(true)
  })

  it('refuses a snapshot-only blob loudly, because a server serves many contexts', () => {
    okFetch()
    const server = new AvsbServer(makeOptions())

    expect(() =>
      server.utils.hydrateBootstrap({
        format: 'avsb-bootstrap-v1',
        snapshot: {
          capturedAt: Date.now(),
          datafileVersion: '2026-05-28T00:00:00.000Z',
          flags: {},
          contextSummary: [{ kind: 'user', key: 'u_1' }],
        },
        producedAt: Date.now(),
      })
    ).toThrow(/does not adopt pre-evaluated snapshots/)
    expect(server.isReady()).toBe(false)
  })
})

describe('pre-ready queueing symmetry', () => {
  it('queues both track and trackPurchase until the datafile arrives, then sends both', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input).includes('datafile.json')) {
        return Promise.resolve(new Response(JSON.stringify(makeDatafile()), { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    global.fetch = fetchMock

    const server = new AvsbServer(makeOptions())

    // trackPurchase used to warn and DROP the order here while track queued.
    server.track('signup', { context: { kind: 'user', key: 'u_1' }, value: 1 })
    await server.trackPurchase('u_1', { orderId: 'o_1', total: 25 })

    await server.onReady()
    await server.flush()

    const metricCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/v1/collect/metric-batch')
    )
    const orderCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/v1/collect/orders')
    )
    expect(metricCalls).toHaveLength(1)
    expect(orderCalls).toHaveLength(1)
    expect(JSON.parse(String(orderCalls[0][1]?.body)).orders[0].orderId).toBe('o_1')
    await server.close()
  })

  it('drops the oldest pre-ready events past the queue cap, with one warning', () => {
    okFetch()
    const logger = makeLogger()
    const server = new AvsbServer(
      makeOptions({ logger, events: { maxQueueSize: 2 } })
    )

    for (let i = 0; i < 5; i++) {
      server.track(`event-${i}`, { context: { kind: 'user', key: 'u_1' } })
    }

    const capWarnings = logger.calls.warn.filter((args) =>
      String(args[0]).includes('Pre-ready event queue')
    )
    expect(capWarnings).toHaveLength(1)
    expect(String(capWarnings[0][0])).toContain('datafile never loaded')
  })
})

// The Environments page marks an environment Stale after five minutes without
// a heartbeat, so an init-only heartbeat made every long-running process look
// dead a few minutes after it started.
describe('heartbeat cadence', () => {
  function heartbeatDatafile() {
    return makeDatafile({
      heartbeatEndpoint: 'https://app.test.invalid/api/sdk/heartbeat',
    })
  }

  function datafileFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input).includes('datafile.json')) {
        return Promise.resolve(
          new Response(JSON.stringify(heartbeatDatafile()), { status: 200 })
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    global.fetch = fetchMock
    return fetchMock as unknown as ReturnType<typeof vi.fn>
  }

  function countHeartbeats(fetchMock: ReturnType<typeof vi.fn>): number {
    return fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/api/sdk/heartbeat')
    ).length
  }

  it('posts the wire shape the Environments page reads', async () => {
    const fetchMock = okFetch()
    const server = new AvsbServer(makeOptions({ bootstrap: heartbeatDatafile() }))
    await server.onReady()

    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/sdk/heartbeat')
    )
    expect(call).toBeDefined()
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      sdkKey: SDK_KEY,
      sdkType: '@avsbhq/node',
      sdkVersion: expect.any(String),
    })
    await server.close()
  })

  it('beats again on a later datafile load, not only at init', async () => {
    const fetchMock = datafileFetch()
    const server = new AvsbServer(makeOptions())
    await server.onReady()
    expect(countHeartbeats(fetchMock)).toBe(1)

    // Past the throttle window, a refresh reports liveness again.
    const realNow = Date.now
    Date.now = () => realNow() + 130_000
    try {
      await server.refreshDatafile()
      expect(countHeartbeats(fetchMock)).toBe(2)
    } finally {
      Date.now = realNow
    }
    await server.close()
  })

  it('throttles, so a fast poll loop cannot turn liveness into traffic', async () => {
    const fetchMock = datafileFetch()
    const server = new AvsbServer(makeOptions())
    await server.onReady()
    await server.refreshDatafile()
    await server.refreshDatafile()

    // Three successful loads inside the window, one heartbeat.
    expect(countHeartbeats(fetchMock)).toBe(1)
    await server.close()
  })

  it('keeps beating when the CDN answers 304, which is the steady state', async () => {
    // With conditional requests wired, an unchanged datafile returns 304 on
    // every poll. A 304 IS a successful refresh: the CDN answered and
    // confirmed what we hold. Heartbeating only on 200 gave one beat at boot
    // and then Stale forever on a perfectly healthy process.
    let served = 0
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (String(input).includes('datafile.json')) {
        served += 1
        if (served > 1) {
          // The second request carries the etag stored from the first.
          const headers = init?.headers as Record<string, string> | undefined
          expect(headers?.['If-None-Match']).toBe('W/"df-1"')
          return Promise.resolve(new Response(null, { status: 304 }))
        }
        return Promise.resolve(
          new Response(JSON.stringify(heartbeatDatafile()), {
            status: 200,
            headers: { etag: 'W/"df-1"' },
          })
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    global.fetch = fetchMock
    const mock = fetchMock as unknown as ReturnType<typeof vi.fn>

    const server = new AvsbServer(makeOptions())
    await server.onReady()
    expect(countHeartbeats(mock)).toBe(1)

    const realNow = Date.now
    Date.now = () => realNow() + 130_000
    try {
      await server.refreshDatafile()
      // No new datafile was applied, but the process is demonstrably alive.
      expect(countHeartbeats(mock)).toBe(2)
    } finally {
      Date.now = realNow
    }
    await server.close()
  })

  it('does not warn on a 304: an up-to-date datafile is not a failed refresh', async () => {
    let served = 0
    global.fetch = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input).includes('datafile.json')) {
        served += 1
        if (served > 1) return Promise.resolve(new Response(null, { status: 304 }))
        return Promise.resolve(
          new Response(JSON.stringify(heartbeatDatafile()), {
            status: 200,
            headers: { etag: 'W/"df-1"' },
          })
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })

    const logger = makeLogger()
    const server = new AvsbServer(makeOptions({ logger }))
    await server.onReady()
    await server.refreshDatafile()

    expect(
      logger.calls.warn.filter((args) =>
        String(args[0]).includes('did not apply a new datafile')
      )
    ).toHaveLength(0)
    await server.close()
  })

  it('sends nothing when the datafile carries no heartbeat endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input).includes('datafile.json')) {
        return Promise.resolve(
          new Response(JSON.stringify(makeDatafile()), { status: 200 })
        )
      }
      return Promise.resolve(new Response('{}', { status: 200 }))
    })
    global.fetch = fetchMock

    const server = new AvsbServer(makeOptions())
    await server.onReady()

    expect(
      countHeartbeats(fetchMock as unknown as ReturnType<typeof vi.fn>)
    ).toBe(0)
    await server.close()
  })
})

describe('getAllFlags guardrails', () => {
  it('warns and returns {} when no context is passed', async () => {
    okFetch()
    const logger = makeLogger()
    const server = new AvsbServer(
      makeOptions({ bootstrap: makeDatafile(), logger })
    )
    await server.onReady()

    expect(server.getAllFlags()).toEqual({})
    expect(String(logger.calls.warn[0][0])).toContain('forUser(context).getAllFlags()')
    await server.close()
  })

  it('warns and returns {} before the datafile loads, instead of looking like an empty project', () => {
    okFetch()
    const logger = makeLogger()
    const server = new AvsbServer(makeOptions({ logger }))

    expect(server.getAllFlags({ kind: 'user', key: 'u_1' })).toEqual({})
    expect(String(logger.calls.warn[0][0])).toContain('indistinguishable')
  })

  it('suppresses exposures by default and reports every flag', async () => {
    const fetchMock = okFetch()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const all = server.getAllFlags({ kind: 'user', key: 'u_1' })
    await server.flush()

    expect(Object.keys(all)).toEqual(['checkout-v2'])
    expect(all['checkout-v2'].value).toBe(true)
    expect(
      fetchMock.mock.calls.filter((call) => String(call[0]).includes('/v1/collect/batch'))
    ).toHaveLength(0)
    await server.close()
  })
})
