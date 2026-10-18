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
// Override surface tests — §5.9
// ---------------------------------------------------------------------------

describe('setOverrideForUser', () => {
  it('forces a specific variation for the targeted user', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    server.setOverrideForUser('test-flag', 'user-1', 'off')
    const flag = server.getFlag('test-flag', true, userContext('user-1'))

    expect(flag.value).toBe(false)
    expect(flag.source).toBe('runtimeOverride')
    await server.close()
  })

  it('does not affect other users', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    server.setOverrideForUser('test-flag', 'user-1', 'off')
    const flagUser1 = server.getFlag('test-flag', true, userContext('user-1'))
    const flagUser2 = server.getFlag('test-flag', false, userContext('user-2'))

    expect(flagUser1.value).toBe(false)
    expect(flagUser2.value).toBe(true) // normal evaluation for user-2
    await server.close()
  })

  it('supports a non-user contextKind via the contextKind parameter', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    // Override for a specific org-kind context key
    server.setOverrideForUser('test-flag', 'org-123', 'off', 'organization')

    // A user context is NOT affected (different kind)
    const userFlag = server.getFlag('test-flag', true, userContext('user-1'))
    expect(userFlag.value).toBe(true) // unaffected
    await server.close()
  })
})

describe('setGlobalOverride', () => {
  it('forces the variation for every user', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    server.setGlobalOverride('test-flag', 'off')
    const flag1 = server.getFlag('test-flag', true, userContext('user-1'))
    const flag2 = server.getFlag('test-flag', true, userContext('user-2'))
    const flag3 = server.getFlag('test-flag', true, userContext('user-999'))

    expect(flag1.value).toBe(false)
    expect(flag2.value).toBe(false)
    expect(flag3.value).toBe(false)
    await server.close()
  })

  it('per-user override takes precedence over the global override', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    server.setGlobalOverride('test-flag', 'off')
    server.setOverrideForUser('test-flag', 'user-1', 'on')

    const flagUser1 = server.getFlag('test-flag', false, userContext('user-1'))
    const flagUser2 = server.getFlag('test-flag', true, userContext('user-2'))

    expect(flagUser1.value).toBe(true)  // per-user wins
    expect(flagUser2.value).toBe(false) // global applies
    await server.close()
  })
})

describe('clearOverrideForUser', () => {
  it('removes per-user override and restores normal evaluation', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    server.setOverrideForUser('test-flag', 'user-1', 'off')
    expect(server.getFlag('test-flag', true, userContext('user-1')).value).toBe(false)

    server.clearOverrideForUser('test-flag', 'user-1')
    expect(server.getFlag('test-flag', false, userContext('user-1')).value).toBe(true)
    await server.close()
  })

  it('is a no-op when no override exists for the given user', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    // Should not throw
    expect(() => {
      server.clearOverrideForUser('test-flag', 'user-1')
    }).not.toThrow()
    await server.close()
  })
})

describe('clearGlobalOverride', () => {
  it('removes only the global override, leaving per-user overrides intact', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    server.setGlobalOverride('test-flag', 'off')
    server.setOverrideForUser('test-flag', 'user-1', 'off')

    server.clearGlobalOverride('test-flag')

    // Global gone — user-2 gets normal evaluation
    expect(server.getFlag('test-flag', false, userContext('user-2')).value).toBe(true)
    // Per-user still in place
    expect(server.getFlag('test-flag', true, userContext('user-1')).value).toBe(false)
    await server.close()
  })
})

describe('clearAllOverrides', () => {
  it('removes both per-user and global overrides for all flags', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    server.setGlobalOverride('test-flag', 'off')
    server.setOverrideForUser('ab-flag', 'user-1', 'variation-a')

    server.clearAllOverrides()

    expect(server.getFlag('test-flag', false, userContext('user-1')).value).toBe(true)
    // ab-flag: normal evaluation — could be 'a' or 'b', either is fine
    const abFlag = server.getFlag<string>('ab-flag', 'default', userContext('user-1'))
    expect(['a', 'b']).toContain(abFlag.value)
    await server.close()
  })
})
