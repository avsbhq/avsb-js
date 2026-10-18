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
        id: 'flag-1',
        key: 'test-flag',
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
        id: 'flag-2',
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
// Tests — §5.13 Flag<T> return shape
// ---------------------------------------------------------------------------

describe('Flag<T> return shape — §5.13', () => {
  it('returns a frozen Flag<T> with all required fields', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const flag = server.getFlag('test-flag', false, userContext('user-1'))

    expect(flag).toHaveProperty('value')
    expect(flag).toHaveProperty('variationKey')
    expect(flag).toHaveProperty('source')
    expect(flag).toHaveProperty('ruleId')
    expect(flag).toHaveProperty('ruleType')
    expect(flag).toHaveProperty('reasons')
    expect(flag).toHaveProperty('evaluatedAt')
    expect(flag).toHaveProperty('durationMicros')
    expect(typeof flag.isEnabled).toBe('function')
    expect(typeof flag.exists).toBe('function')
    await server.close()
  })

  it('flag.isEnabled() returns true when a rule matched and the value is truthy', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const flag = server.getFlag('test-flag', false, userContext('user-1'))

    expect(flag.source).toBe('rule')
    expect(flag.isEnabled()).toBe(true)
    await server.close()
  })

  it('flag.exists() returns false for a key the loaded datafile does not carry', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const foundFlag = server.getFlag('test-flag', false, userContext('user-1'))
    const missingFlag = server.getFlag('nonexistent', false, userContext('user-1'))

    expect(foundFlag.exists()).toBe(true)
    expect(missingFlag.source).toBe('not_found')
    expect(missingFlag.exists()).toBe(false)
    await server.close()
  })

  it('not_found flag has the defaultValue as its value', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const flag = server.getFlag('nonexistent-flag', 'my-default', userContext('user-1'))

    expect(flag.source).toBe('not_found')
    expect(flag.value).toBe('my-default')
    expect(flag.variationKey).toBeNull()
    expect(flag.ruleId).toBeNull()
    await server.close()
  })

  it('rule-matched flag has correct variationKey, ruleId, ruleType', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const flag = server.getFlag('test-flag', false, userContext('user-1'))

    expect(flag.variationKey).toBe('on')
    expect(flag.ruleId).toBe('rule-td-1')
    expect(flag.ruleType).toBe('targeted_delivery')
    expect(flag.source).toBe('rule')
    await server.close()
  })

  it('flag object is frozen (immutable)', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const flag = server.getFlag('test-flag', false, userContext('user-1'))

    expect(Object.isFrozen(flag)).toBe(true)
    await server.close()
  })
})
