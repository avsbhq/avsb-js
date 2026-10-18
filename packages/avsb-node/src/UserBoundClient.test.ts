import type { FlagDatafile } from '@avsbhq/core'
import { userContext } from '@avsbhq/core'
import { AvsbServer } from './AvsbServer'
import type { AvsbServerOptions } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDatafile(overrides: Partial<FlagDatafile> = {}): FlagDatafile {
  return {
    version: 1,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'test-sdk-key',
    environmentKey: 'test',
    publishedAt: '2024-01-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.example.com',
    flags: [
      {
        id: 'flag-bool',
        key: 'bool-flag',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'var-off',
        variations: [
          { id: 'var-off', key: 'off', value: false },
          { id: 'var-on', key: 'on', value: true },
        ],
        overrides: [],
        rules: [
          {
            id: 'rule-td-1',
            type: 'targeted_delivery',
            enabled: true,
            audienceIds: [],
            hashAttribute: 'userId',
            trafficAllocation: null,
            variations: [{ variationId: 'var-on', percentage: 1 }],
          },
        ],
      },
      {
        id: 'flag-str',
        key: 'str-flag',
        type: 'string',
        enabled: true,
        defaultVariationId: 'var-default',
        variations: [
          { id: 'var-default', key: 'default-var', value: 'default' },
          { id: 'var-premium', key: 'premium-var', value: 'premium' },
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
              { variationId: 'var-default', percentage: 0.5 },
              { variationId: 'var-premium', percentage: 0.5 },
            ],
          },
        ],
      },
      {
        id: 'flag-num',
        key: 'num-flag',
        type: 'number',
        enabled: true,
        defaultVariationId: 'var-zero',
        variations: [
          { id: 'var-zero', key: 'zero', value: 0 },
          { id: 'var-hundred', key: 'hundred', value: 100 },
        ],
        overrides: [],
        rules: [
          {
            id: 'rule-num-1',
            type: 'targeted_delivery',
            enabled: true,
            audienceIds: [],
            hashAttribute: 'userId',
            trafficAllocation: null,
            variations: [{ variationId: 'var-hundred', percentage: 1 }],
          },
        ],
      },
    ],
    audiences: [],
    ...overrides,
  }
}

function makeOptions(overrides: Partial<AvsbServerOptions> = {}): AvsbServerOptions {
  return {
    sdkKey: 'test-sdk-key',
    pollingInterval: 300_000,
    initTimeout: 5000,
    ...overrides,
  }
}

function mockFetchSuccess(datafile: FlagDatafile = makeDatafile()): void {
  global.fetch = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(datafile), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

const originalFetch = global.fetch

afterEach(async () => {
  global.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UserBoundClient — forUser()', () => {
  it('getFlag returns a Flag<T> evaluated with the bound context', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const bound = server.forUser(userContext('user-1'))
    const flag = bound.getFlag('bool-flag', false)

    expect(flag.value).toBe(true)
    expect(flag.source).toBe('rule')
    expect(flag.isEnabled()).toBe(true)
    await server.close()
  })

  it('getDecisionLog accumulates entries across multiple evaluations', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const bound = server.forUser(userContext('user-1'))
    bound.getFlag('bool-flag', false)
    bound.getFlag<string>('str-flag', 'x')
    bound.getFlag('nonexistent', false)

    const log = bound.getDecisionLog()
    expect(log.entries).toHaveLength(3)
    expect(log.entries[0].flagKey).toBe('bool-flag')
    expect(log.entries[1].flagKey).toBe('str-flag')
    expect(log.entries[2].flagKey).toBe('nonexistent')
    // Verify §2.5 shape: durationMicros + contextSummary present
    expect(typeof log.entries[0].durationMicros).toBe('number')
    expect(log.entries[0].contextSummary).toEqual([{ kind: 'user', key: 'user-1' }])
    await server.close()
  })

  it('track delegates to server.track with the bound context', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy

    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const bound = server.forUser(userContext('user-1'))
    bound.track('purchase', { value: 49.99, properties: { plan: 'pro' } })
    await server.flush()

    const metricCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/metric-batch')
    )
    expect(metricCalls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(metricCalls[0][1]?.body as string)
    expect(body.metricEvents[0].visitorId).toBe('user-1')
    // The bound client forwards the payload untouched: `value` stays `value`.
    expect(body.metricEvents[0].value).toBe(49.99)
    expect(body.metricEvents[0].revenue).toBeNull()
    await server.close()
  })

  it('typed variants: getBoolFlag, getStringFlag, getNumberFlag work correctly', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const bound = server.forUser(userContext('user-1'))
    const boolFlag = bound.getBoolFlag('bool-flag', false)
    const strFlag = bound.getStringFlag('str-flag', 'fallback')
    const numFlag = bound.getNumberFlag('num-flag', 0)

    expect(boolFlag.value).toBe(true)
    expect(typeof strFlag.value).toBe('string')
    expect(numFlag.value).toBe(100)
    await server.close()
  })

  it('setForcedDecision overrides the flag evaluation for this client only', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const bound = server.forUser(userContext('user-1'))
    // Without forced decision: targeted_delivery fires 'on' (true)
    expect(bound.getFlag('bool-flag', false).value).toBe(true)

    bound.setForcedDecision('bool-flag', { variationKey: 'off' })
    expect(bound.getFlag('bool-flag', false).value).toBe(false)

    // Another bound client for the same user is NOT affected
    const bound2 = server.forUser(userContext('user-1'))
    expect(bound2.getFlag('bool-flag', false).value).toBe(true)

    await server.close()
  })

  it('clearForcedDecision restores normal evaluation', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const bound = server.forUser(userContext('user-1'))
    bound.setForcedDecision('bool-flag', { variationKey: 'off' })
    expect(bound.getFlag('bool-flag', false).value).toBe(false)

    bound.clearForcedDecision('bool-flag')
    expect(bound.getFlag('bool-flag', false).value).toBe(true)

    await server.close()
  })

  it('getAllFlags returns a record of Flag objects via the bound client', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const bound = server.forUser(userContext('user-1'))
    const flags = bound.getAllFlags()

    expect(flags).toHaveProperty('bool-flag')
    expect(flags).toHaveProperty('str-flag')
    expect(flags).toHaveProperty('num-flag')
    // Each entry must be a proper Flag shape
    expect(typeof flags['bool-flag'].isEnabled).toBe('function')
    expect(typeof flags['bool-flag'].exists).toBe('function')
    await server.close()
  })
})
