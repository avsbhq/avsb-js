import type { FlagDatafile, Logger } from '@avsbhq/core'
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
            id: 'rule-str-1',
            type: 'targeted_delivery',
            enabled: true,
            audienceIds: [],
            hashAttribute: 'userId',
            trafficAllocation: null,
            variations: [{ variationId: 'var-premium', percentage: 1 }],
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
      {
        id: 'flag-json',
        key: 'json-flag',
        type: 'json',
        enabled: true,
        defaultVariationId: 'var-empty',
        variations: [
          { id: 'var-empty', key: 'empty', value: {} },
          { id: 'var-config', key: 'config', value: { theme: 'dark', items: 5 } },
        ],
        overrides: [],
        rules: [
          {
            id: 'rule-json-1',
            type: 'targeted_delivery',
            enabled: true,
            audienceIds: [],
            hashAttribute: 'userId',
            trafficAllocation: null,
            variations: [{ variationId: 'var-config', percentage: 1 }],
          },
        ],
      },
      // A boolean flag declared in datafile but with number value — for type mismatch test
      {
        id: 'flag-mistyped',
        key: 'mistyped-flag',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'var-num',
        variations: [
          // value is a number but flag.type is 'boolean' — type mismatch
          { id: 'var-num', key: 'the-num', value: 42 },
        ],
        overrides: [],
        rules: [],
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

function makeLogger(): Logger & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = { debug: [], info: [], warn: [], error: [] }
  const logger: Logger & { calls: Record<string, unknown[][]> } = {
    calls,
    debug(...args: unknown[]) { calls.debug.push(args) },
    info(...args: unknown[]) { calls.info.push(args) },
    warn(...args: unknown[]) { calls.warn.push(args) },
    error(...args: unknown[]) { calls.error.push(args) },
    child() { return logger },
  }
  return logger
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
// Tests — §5.11 typed variants
// ---------------------------------------------------------------------------

describe('getBoolFlag', () => {
  it('returns a boolean Flag<boolean> for a correctly-typed flag', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const flag = server.getBoolFlag('bool-flag', false, userContext('u1'))

    expect(flag.value).toBe(true)
    expect(typeof flag.value).toBe('boolean')
    await server.close()
  })

  it('returns the default flag and logs a warning on type mismatch', async () => {
    mockFetchSuccess()
    const logger = makeLogger()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile(), logger }))
    await server.onReady()

    // 'mistyped-flag' is declared as 'boolean' in the datafile but resolved value 42 (number)
    const flag = server.getBoolFlag('mistyped-flag', false, userContext('u1'))

    expect(flag.source).toBe('not_found')
    expect(flag.value).toBe(false) // falls back to default
    expect(logger.calls.warn.length).toBeGreaterThan(0)
    const warnMsg = String(logger.calls.warn[0][0])
    expect(warnMsg).toContain('Type mismatch')
    await server.close()
  })

  it('returns a not_ready flag when the SDK has no datafile (B15)', () => {
    const server = new AvsbServer(makeOptions())
    const flag = server.getBoolFlag('bool-flag', false, userContext('u1'))
    // A pre-ready read must NOT be reported as a type mismatch or a missing
    // key: there is nothing to type-check against yet.
    expect(flag.source).toBe('not_ready')
    expect(flag.value).toBe(false)
  })
})

describe('getStringFlag', () => {
  it('returns a string Flag<string> for a correctly-typed flag', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const flag = server.getStringFlag('str-flag', 'fallback', userContext('u1'))

    expect(flag.value).toBe('premium')
    expect(typeof flag.value).toBe('string')
    await server.close()
  })

  it('returns the default and warns when a boolean flag is requested as string', async () => {
    mockFetchSuccess()
    const logger = makeLogger()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile(), logger }))
    await server.onReady()

    // bool-flag is declared as 'boolean', requesting as 'string' is a mismatch
    const flag = server.getStringFlag('bool-flag', 'default-str', userContext('u1'))

    expect(flag.source).toBe('not_found')
    expect(flag.value).toBe('default-str')
    expect(logger.calls.warn.length).toBeGreaterThan(0)
    await server.close()
  })
})

describe('getNumberFlag', () => {
  it('returns a numeric Flag<number> for a correctly-typed flag', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const flag = server.getNumberFlag('num-flag', -1, userContext('u1'))

    expect(flag.value).toBe(100)
    expect(typeof flag.value).toBe('number')
    await server.close()
  })
})

describe('getJsonFlag', () => {
  it('returns a typed JSON Flag<T> for a correctly-typed flag', async () => {
    mockFetchSuccess()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await server.onReady()

    const flag = server.getJsonFlag<{ theme: string; items: number }>(
      'json-flag',
      { theme: 'light', items: 0 },
      userContext('u1')
    )

    expect(flag.value.theme).toBe('dark')
    expect(flag.value.items).toBe(5)
    await server.close()
  })

  it('returns default and warns when json flag resolves to undefined (disabled, not_found)', async () => {
    mockFetchSuccess()
    const logger = makeLogger()
    const server = new AvsbServer(makeOptions({ bootstrap: makeDatafile(), logger }))
    await server.onReady()

    // Requesting json type for a boolean flag triggers a mismatch warning
    const flag = server.getJsonFlag('bool-flag', { default: true }, userContext('u1'))

    expect(flag.source).toBe('not_found')
    expect(logger.calls.warn.length).toBeGreaterThan(0)
    await server.close()
  })
})
