import type { FlagDatafile } from '@avsbhq/core'
import { AvsbServer } from './AvsbServer'
import { createDecisionLog } from './decisionLog'
import { InMemoryStickyBucketService } from './stickyBucket'
import type { AvsbServerOptions } from './types'
import type { StickyAssignment, DecisionLogEntry, EvalContext, Logger } from '@avsbhq/core'
import { userContext } from '@avsbhq/core'

function makeAssignment(overrides: Partial<StickyAssignment> = {}): StickyAssignment {
  return {
    variationId: 'var-off',
    ruleId: 'rule-td-1',
    ruleType: 'ab_test',
    assignedAt: 1_700_000_000_000,
    ...overrides,
  }
}

// --- Helpers ---

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

const KEY = 'sdk_production_nodetest0000001'

function makeOptions(overrides: Partial<AvsbServerOptions> = {}): AvsbServerOptions {
  return {
    // A REAL-shaped key. The SDK logs a loud `error` for a key that cannot be
    // one (spec §1.2), so a placeholder here put a line into every test's error
    // log and made "did this test log an error?" unanswerable.
    sdkKey: KEY,
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

function mockFetchFailure(status = 500): void {
  global.fetch = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('error', { status })
  )
}

function makeLogger(): Logger & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    debug: [], info: [], warn: [], error: [],
  }
  return {
    calls,
    debug(...args: unknown[]) { calls.debug.push(args) },
    info(...args: unknown[]) { calls.info.push(args) },
    warn(...args: unknown[]) { calls.warn.push(args) },
    error(...args: unknown[]) { calls.error.push(args) },
    child() { return this },
  }
}

// Convenience: user-kind EvalContext from a userId string
function ctx(userId: string, attributes?: Record<string, unknown>): EvalContext {
  return userContext(userId, attributes)
}

const originalFetch = global.fetch

afterEach(async () => {
  global.fetch = originalFetch
  vi.useRealTimers()
})

// ========================
// Initialization
// ========================

describe('Initialization', () => {
  it('resolves with bootstrap source when bootstrap provided', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    const result = await client.onReady()

    expect(result.success).toBe(true)
    expect(result.source).toBe('bootstrap')
    await client.close()
  })

  it('resolves with network source when CDN fetch succeeds', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions())
    const result = await client.onReady()

    expect(result.success).toBe(true)
    expect(result.source).toBe('network')
    await client.close()
  })

  it('fetches the datafile from the default CDN host when no override is provided', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), { status: 200 })
    )
    global.fetch = fetchMock

    const client = new AvsbServer(makeOptions())
    await client.onReady()

    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toBe(
      `https://cdn.avsb.cloud/${KEY}/datafile.json`
    )
    await client.close()
  })

  it('uses a custom cdnHost when provided', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), { status: 200 })
    )
    global.fetch = fetchMock

    const client = new AvsbServer(
      makeOptions({ cdnHost: 'https://custom.example.com' })
    )
    await client.onReady()

    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toBe(
      `https://custom.example.com/${KEY}/datafile.json`
    )
    await client.close()
  })

  it('strips a trailing slash from a custom cdnHost', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), { status: 200 })
    )
    global.fetch = fetchMock

    const client = new AvsbServer(
      makeOptions({ cdnHost: 'https://custom.example.com/' })
    )
    await client.onReady()

    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toBe(
      `https://custom.example.com/${KEY}/datafile.json`
    )
    await client.close()
  })

  it('resolves with timeout when CDN is slow', async () => {
    vi.useFakeTimers()
    global.fetch = vi.fn<typeof fetch>().mockImplementation(
      () => new Promise(() => {}) // never resolves
    )
    const client = new AvsbServer(makeOptions({ initTimeout: 1000 }))
    const readyPromise = client.onReady()
    await vi.advanceTimersByTimeAsync(1100)
    const result = await readyPromise

    expect(result.success).toBe(false)
    expect(result.source).toBe('timeout')
    await client.close()
    vi.useRealTimers()
  })

  it('resolves with error when CDN returns 500', async () => {
    mockFetchFailure(500)
    const client = new AvsbServer(makeOptions())
    const result = await client.onReady()

    expect(result.success).toBe(false)
    expect(result.source).toBe('error')
    await client.close()
  })

  it('returns the same Promise for multiple onReady calls', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions())
    const p1 = client.onReady()
    const p2 = client.onReady()

    expect(p1).toBe(p2)
    await p1
    await client.close()
  })

  it('emits ready event on success', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions())
    const readySpy = vi.fn()
    client.on('ready', readySpy)

    await client.onReady()

    expect(readySpy).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('emits error event on timeout', async () => {
    vi.useFakeTimers()
    global.fetch = vi.fn<typeof fetch>().mockImplementation(
      () => new Promise(() => {})
    )
    const client = new AvsbServer(makeOptions({ initTimeout: 1000 }))
    const errorSpy = vi.fn()
    client.on('error', errorSpy)

    const readyPromise = client.onReady()
    await vi.advanceTimersByTimeAsync(1100)
    await readyPromise

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(errorSpy.mock.calls[0][0].message).toContain('timed out')
    await client.close()
    vi.useRealTimers()
  })
})

// ========================
// Flag evaluation — new Flag<T> return shape
// ========================

describe('Flag evaluation', () => {
  it('returns a not_ready flag when the datafile has not loaded (B15)', () => {
    const client = new AvsbServer(makeOptions())
    const flag = client.getFlag('test-flag', false, ctx('user-1'))

    expect(flag.value).toBe(false)
    expect(flag.source).toBe('not_ready')
    expect(flag.isEnabled()).toBe(false)
    expect(flag.exists()).toBe(false)
    expect(flag.reasons[0]).toContain('not ready')
  })

  it('warns once, actionably, on a pre-ready read', () => {
    const logger = makeLogger()
    const client = new AvsbServer(makeOptions({ logger }))

    client.getFlag('test-flag', false, ctx('user-1'))
    client.getFlag('other-flag', false, ctx('user-1'))

    // Once per process, so a request loop cannot flood a log.
    expect(logger.calls.warn).toHaveLength(1)
    const message = String(logger.calls.warn[0][0])
    expect(message).toContain('onReady')
    expect(message).toContain('bootstrap')
  })

  it('returns correct Flag<T> for targeted_delivery flag', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const flag = client.getFlag('test-flag', false, ctx('user-1'))

    expect(flag.value).toBe(true)
    expect(flag.source).toBe('rule')
    expect(flag.isEnabled()).toBe(true)
    await client.close()
  })

  it('evaluates different users who may get different ab_test variations', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const values = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const flag = client.getFlag<string>('ab-flag', 'default', ctx(`user-${i}`))
      values.add(flag.value)
    }

    expect(values.has('a')).toBe(true)
    expect(values.has('b')).toBe(true)
    await client.close()
  })

  it('returns not_found flag for unknown flag key', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const flag = client.getFlag('nonexistent-flag', 'fallback', ctx('user-1'))

    expect(flag.source).toBe('not_found')
    expect(flag.value).toBe('fallback')
    await client.close()
  })

  it('returns all flags via getAllFlags as Flag objects', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const flags = client.getAllFlags(ctx('user-1'))

    expect(flags).toHaveProperty('test-flag')
    expect(flags).toHaveProperty('ab-flag')
    expect(flags['test-flag'].value).toBe(true)
    expect(['a', 'b']).toContain(flags['ab-flag'].value)
    await client.close()
  })

  it('getAllFlags returns empty object when SDK is not ready', () => {
    const client = new AvsbServer(makeOptions())
    const flags = client.getAllFlags(ctx('user-1'))

    expect(flags).toEqual({})
  })

  it('names the fix when the context is missing', async () => {
    mockFetchSuccess()
    const logger = makeLogger()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile(), logger }))
    await client.onReady()

    // No context provided.
    const flag = client.getFlag('test-flag', 'fallback')
    expect(flag.source).toBe('not_ready')
    expect(flag.value).toBe('fallback')
    expect(flag.reasons[0]).toContain('forUser')
    // Spec §1.2: the warning names the factory call to add.
    expect(String(logger.calls.warn[0][0])).toContain('server.forUser(')
    await client.close()
  })
})

// ========================
// Runtime overrides — new API
// ========================

describe('Runtime overrides', () => {
  it('forces variation for a specific user via setOverrideForUser', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.setOverrideForUser('test-flag', 'user-1', 'off')
    const flag = client.getFlag('test-flag', true, ctx('user-1'))

    expect(flag.value).toBe(false)
    await client.close()
  })

  it('forces variation for all users via setGlobalOverride', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.setGlobalOverride('test-flag', 'off')
    const val1 = client.getFlag('test-flag', true, ctx('user-1'))
    const val2 = client.getFlag('test-flag', true, ctx('user-2'))

    expect(val1.value).toBe(false)
    expect(val2.value).toBe(false)
    await client.close()
  })

  it('removes per-user override via clearOverrideForUser', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.setOverrideForUser('test-flag', 'user-1', 'off')
    client.clearOverrideForUser('test-flag', 'user-1')
    const flag = client.getFlag('test-flag', false, ctx('user-1'))

    // Without override, targeted_delivery serves 'on' (true)
    expect(flag.value).toBe(true)
    await client.close()
  })

  it('removes all overrides via clearAllOverrides', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.setOverrideForUser('test-flag', 'user-1', 'off')
    client.setOverrideForUser('ab-flag', 'user-2', 'variation-a')
    client.clearAllOverrides()

    const flag = client.getFlag('test-flag', false, ctx('user-1'))
    expect(flag.value).toBe(true) // back to targeted_delivery result
    await client.close()
  })

  it('per-user override takes precedence over normal evaluation', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    // Without override, targeted_delivery returns true
    expect(client.getFlag('test-flag', false, ctx('user-1')).value).toBe(true)

    // Override forces false
    client.setOverrideForUser('test-flag', 'user-1', 'off')
    expect(client.getFlag('test-flag', false, ctx('user-1')).value).toBe(false)

    await client.close()
  })

  it('clearGlobalOverride removes only the global override', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.setGlobalOverride('test-flag', 'off')
    expect(client.getFlag('test-flag', false, ctx('user-1')).value).toBe(false)

    client.clearGlobalOverride('test-flag')
    expect(client.getFlag('test-flag', false, ctx('user-1')).value).toBe(true)

    await client.close()
  })
})

// ========================
// Sticky bucketing
// ========================

describe('Sticky bucketing', () => {
  it('evaluations work normally without sticky bucket service', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const flag = client.getFlag('test-flag', false, ctx('user-1'))
    expect(flag.value).toBe(true)
    await client.close()
  })

  it('does NOT save sticky assignment for targeted_delivery rules', async () => {
    mockFetchSuccess()
    const stickyService = new InMemoryStickyBucketService()
    const saveSpy = vi.spyOn(stickyService, 'save')
    const client = new AvsbServer(makeOptions({
      bootstrap: makeDatafile(),
      stickyBucketService: stickyService,
    }))
    await client.onReady()

    client.getFlag('test-flag', false, ctx('user-1'))

    expect(saveSpy).not.toHaveBeenCalled()
    await client.close()
  })

  it('saves StickyAssignment with ruleId + ruleType + assignedAt for ab_test rules', async () => {
    mockFetchSuccess()
    const stickyService = new InMemoryStickyBucketService()
    const saveSpy = vi.spyOn(stickyService, 'save')
    const client = new AvsbServer(makeOptions({
      bootstrap: makeDatafile(),
      stickyBucketService: stickyService,
    }))
    await client.onReady()

    client.getFlag<string>('ab-flag', 'default', ctx('user-1'))

    expect(saveSpy).toHaveBeenCalledTimes(1)
    const args = saveSpy.mock.calls[0]
    expect(args[0]).toBe('user-1')
    expect(args[1]).toBe('ab-flag')
    expect(args[2]).toMatchObject({
      ruleId: 'rule-ab-1',
      ruleType: 'ab_test',
    })
    expect(typeof (args[2] as StickyAssignment).variationId).toBe('string')
    expect(typeof (args[2] as StickyAssignment).assignedAt).toBe('number')
    await client.close()
  })

  it('returns stored assignment when variation + rule still exist', async () => {
    mockFetchSuccess()
    const stickyService = new InMemoryStickyBucketService()
    const client = new AvsbServer(makeOptions({
      bootstrap: makeDatafile(),
      stickyBucketService: stickyService,
    }))
    await client.onReady()

    stickyService.save('user-1', 'ab-flag', makeAssignment({
      variationId: 'var-a',
      ruleId: 'rule-ab-1',
      ruleType: 'ab_test',
    }))
    const flag = client.getFlag<string>('ab-flag', 'default', ctx('user-1'))

    expect(flag.value).toBe('a')
    await client.close()
  })

  it('emits stickyOrphan when assigned rule no longer matches the datafile', async () => {
    mockFetchSuccess()
    const stickyService = new InMemoryStickyBucketService()
    const client = new AvsbServer(makeOptions({
      bootstrap: makeDatafile(),
      stickyBucketService: stickyService,
    }))
    await client.onReady()

    stickyService.save('user-1', 'ab-flag', makeAssignment({
      variationId: 'var-a',
      ruleId: 'rule_that_was_deleted',
      ruleType: 'ab_test',
    }))

    const orphanSpy = vi.fn()
    client.on('stickyOrphan', orphanSpy)
    client.getFlag<string>('ab-flag', 'default', ctx('user-1'))

    expect(orphanSpy).toHaveBeenCalledTimes(1)
    expect(orphanSpy.mock.calls[0][0]).toMatchObject({
      flagKey: 'ab-flag',
      userId: 'user-1',
      assignment: expect.objectContaining({ ruleId: 'rule_that_was_deleted' }),
    })
    await client.close()
  })

  it('re-evaluates when stored variationId no longer exists on the flag', async () => {
    mockFetchSuccess()
    const stickyService = new InMemoryStickyBucketService()
    const client = new AvsbServer(makeOptions({
      bootstrap: makeDatafile(),
      stickyBucketService: stickyService,
    }))
    await client.onReady()

    stickyService.save('user-1', 'ab-flag', makeAssignment({
      variationId: 'var-deleted',
      ruleId: 'rule-ab-1',
      ruleType: 'ab_test',
    }))
    const flag = client.getFlag<string>('ab-flag', 'default', ctx('user-1'))

    expect(['a', 'b']).toContain(flag.value)
    await client.close()
  })
})

// ========================
// Exposure control
// ========================

describe('Exposure control', () => {
  it('suppresses exposure via DISABLE_EXPOSURE decideOption', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy

    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.getFlag('ab-flag', 'default', ctx('user-1'), {
      decideOptions: ['DISABLE_EXPOSURE'],
    })

    await client.flush()

    const batchCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/batch')
    )
    expect(batchCalls).toHaveLength(0)
    await client.close()
  })

  it('deduplication: same flag in same decisionLog records both entries', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const log = createDecisionLog()

    client.getFlag('test-flag', false, ctx('user-1'), { decisionLog: log })
    expect(log.entries).toHaveLength(1)

    client.getFlag('test-flag', false, ctx('user-1'), { decisionLog: log })
    expect(log.entries).toHaveLength(2)
    await client.close()
  })

  it('fires exposure manually via manualExposure for ab_test flags', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy

    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.manualExposure('ab-flag', ctx('user-1'))
    await client.flush()

    const batchCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/batch')
    )
    expect(batchCalls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(batchCalls[0][1]?.body as string)
    expect(body.events[0].properties).toMatchObject({ flagKey: 'ab-flag', manuallyFired: true })
    await client.close()
  })

  it('manualExposure preserves the full attribute set during re-evaluation', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy

    const datafile = makeDatafile({
      audiences: [{
        id: 'aud-1',
        rules: {
          id: 'group-1', logic: 'AND',
          conditions: [{ id: 'c-1', type: 'CUSTOM_ATTRIBUTE', attribute: 'plan', operator: 'equals', value: 'pro' }],
        },
      }],
    })
    datafile.flags.push({
      id: 'flag-3', key: 'pro-flag', type: 'boolean',
      enabled: true, defaultVariationId: 'var-off',
      variations: [
        { id: 'var-off', key: 'off', value: false },
        { id: 'var-on', key: 'on', value: true },
      ],
      overrides: [],
      rules: [{
        id: 'rule-pro', type: 'ab_test', enabled: true,
        audienceIds: ['aud-1'], hashAttribute: 'userId', trafficAllocation: 1,
        variations: [{ variationId: 'var-on', percentage: 1 }],
      }],
    })

    const client = new AvsbServer(makeOptions({ bootstrap: datafile }))
    await client.onReady()

    client.manualExposure('pro-flag', ctx('user-1', { plan: 'pro' }))
    await client.flush()

    const batchCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/batch')
    )
    expect(batchCalls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(batchCalls[0][1]?.body as string)
    expect(body.events[0].variationId).toBe('var-on')
    await client.close()
  })

  it('manualExposure fires exposure for targeted_delivery rules too', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy

    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.manualExposure('test-flag', ctx('user-1'))
    await client.flush()

    const batchCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/batch')
    )
    expect(batchCalls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(batchCalls[0][1]?.body as string)
    expect(body.events[0].properties).toMatchObject({ flagKey: 'test-flag', manuallyFired: true })
    await client.close()
  })
})

// ========================
// Private attributes
// ========================

describe('Private attributes', () => {
  // The context attributes ride `event.attributes`, built by the evaluator from
  // the project's REGISTERED attribute list. `properties` only ever carries
  // decision metadata, so a test asserting on properties passed while the
  // actual values shipped: this datafile registers both keys so the exposure
  // really does carry them.
  function registeredDatafile() {
    return makeDatafile({ registeredAttributes: ['plan', 'secret'] })
  }

  const privateCtx: EvalContext = {
    kind: 'user',
    key: 'user-1',
    plan: 'enterprise',
    secret: 'hidden',
    _meta: { privateAttributes: ['secret'] },
  }

  it('never sends a private attribute value in a queued exposure', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(registeredDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy

    const client = new AvsbServer(makeOptions({
      bootstrap: registeredDatafile(),
      events: { batchSize: 1 },
    }))
    await client.onReady()

    client.getFlag('ab-flag', 'default', privateCtx)
    await client.flush()

    const batchCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/batch')
    )
    expect(batchCalls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(batchCalls[0][1]?.body as string)
    const serialised = JSON.stringify(body)

    for (const event of body.events) {
      expect(event.attributes).not.toHaveProperty('secret')
      expect(event.properties).not.toHaveProperty('secret')
      // The non-private registered attribute still ships: redaction removes
      // what was named, not the whole map.
      expect(event.attributes).toMatchObject({ plan: 'enterprise' })
    }
    // The VALUE never appears anywhere in the body, under any key.
    expect(serialised).not.toContain('hidden')

    await client.close()
  })

  it('redacts the exposure handed to the event bus too, not just the wire', async () => {
    mockFetchSuccess(registeredDatafile())
    const client = new AvsbServer(
      makeOptions({ bootstrap: registeredDatafile() })
    )
    await client.onReady()

    const exposures: Array<{ attributes?: Record<string, string> }> = []
    client.on('exposure', (event) => exposures.push(event))

    client.getFlag('ab-flag', 'default', privateCtx)

    expect(exposures).toHaveLength(1)
    expect(exposures[0].attributes).not.toHaveProperty('secret')
    expect(exposures[0].attributes).toMatchObject({ plan: 'enterprise' })
    await client.close()
  })

  it('leaves the exposure untouched when the context declares nothing private', async () => {
    mockFetchSuccess(registeredDatafile())
    const client = new AvsbServer(
      makeOptions({ bootstrap: registeredDatafile() })
    )
    await client.onReady()

    const exposures: Array<{ attributes?: Record<string, string> }> = []
    client.on('exposure', (event) => exposures.push(event))

    client.getFlag('ab-flag', 'default', {
      kind: 'user',
      key: 'user-1',
      plan: 'enterprise',
      secret: 'hidden',
    })

    expect(exposures[0].attributes).toMatchObject({
      plan: 'enterprise',
      secret: 'hidden',
    })
    await client.close()
  })

  it('uses private attributes for evaluation context', async () => {
    const datafileWithAudience = makeDatafile({
      audiences: [
        {
          id: 'aud-1',
          rules: {
            id: 'group-1',
            logic: 'AND',
            conditions: [
              { id: 'cond-1', type: 'CUSTOM_ATTRIBUTE', attribute: 'internalRole', operator: 'equals', value: 'admin' },
            ],
          },
        },
      ],
    })
    datafileWithAudience.flags.push({
      id: 'flag-3',
      key: 'admin-flag',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var-no',
      variations: [
        { id: 'var-no', key: 'no', value: false },
        { id: 'var-yes', key: 'yes', value: true },
      ],
      overrides: [],
      rules: [
        {
          id: 'rule-audience-1',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: ['aud-1'],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var-yes', percentage: 1 }],
        },
      ],
    })

    mockFetchSuccess(datafileWithAudience)
    const client = new AvsbServer(makeOptions({ bootstrap: datafileWithAudience }))
    await client.onReady()

    const privateCtx: EvalContext = {
      kind: 'user',
      key: 'user-1',
      internalRole: 'admin',
      _meta: { privateAttributes: ['internalRole'] },
    }
    const flag = client.getFlag('admin-flag', false, privateCtx)

    expect(flag.value).toBe(true)
    await client.close()
  })
})

// ========================
// Decision log — durationMicros
// ========================

describe('Decision log', () => {
  it('records entries with correct shape (durationMicros, contextSummary)', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const log = createDecisionLog()
    client.getFlag('test-flag', false, ctx('user-1'), { decisionLog: log })

    expect(log.entries).toHaveLength(1)
    const entry = log.entries[0] as DecisionLogEntry
    expect(entry.flagKey).toBe('test-flag')
    expect(entry.value).toBe(true)
    expect(entry.source).toBe('rule')
    expect(entry.reasons.length).toBeGreaterThan(0)
    expect(typeof entry.evaluatedAt).toBe('number')
    expect(typeof entry.durationMicros).toBe('number')
    expect(Array.isArray(entry.contextSummary)).toBe(true)
    expect(entry.contextSummary[0]).toEqual({ kind: 'user', key: 'user-1' })
    await client.close()
  })

  it('accumulates multiple evaluations in the same log', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const log = createDecisionLog()
    client.getFlag('test-flag', false, ctx('user-1'), { decisionLog: log })
    client.getFlag<string>('ab-flag', 'default', ctx('user-1'), { decisionLog: log })
    client.getFlag('nonexistent', false, ctx('user-1'), { decisionLog: log })

    expect(log.entries).toHaveLength(3)
    expect(log.entries[0].flagKey).toBe('test-flag')
    expect(log.entries[1].flagKey).toBe('ab-flag')
    expect(log.entries[2].flagKey).toBe('nonexistent')
    await client.close()
  })

  it('createDecisionLog is accessible on the class', () => {
    const client = new AvsbServer(makeOptions())
    const log = client.createDecisionLog()

    expect(log).toBeDefined()
    expect(log.entries).toEqual([])
  })
})

// ========================
// forUser / createUserContext
// ========================

describe('forUser and createUserContext', () => {
  it('creates a UserBoundClient that evaluates with the bound context', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const bound = client.forUser(ctx('user-1'))
    const flag = bound.getFlag('test-flag', false)

    expect(flag.value).toBe(true)
    await client.close()
  })

  it('createUserContext is an alias for forUser', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const bound = client.createUserContext(ctx('user-1'))
    const flag = bound.getFlag('test-flag', false)

    expect(flag.value).toBe(true)
    await client.close()
  })
})

// ========================
// Lifecycle events
// ========================

describe('Lifecycle events', () => {
  it('fires evaluation event on every getFlag call', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const evalSpy = vi.fn()
    client.on('evaluation', evalSpy)

    client.getFlag('test-flag', false, ctx('user-1'))
    client.getFlag<string>('ab-flag', 'default', ctx('user-2'))

    expect(evalSpy).toHaveBeenCalledTimes(2)
    // The payload is the SHARED ClientEventMap shape now: {flagKey, flag,
    // contextKeys}. It used to be {flagKey, value, userId, source} on the
    // server only, and the client.utils adapter cast between the two, so a
    // utils consumer received an object with none of the documented fields.
    const first = evalSpy.mock.calls[0][0] as {
      flagKey: string
      flag: { value: unknown; source: string }
      contextKeys: string[]
    }
    expect(first.flagKey).toBe('test-flag')
    expect(first.contextKeys).toEqual(['user-1'])
    expect(first.flag.source).toBe('rule')
    expect(first.flag.value).toBe(true)

    const second = evalSpy.mock.calls[1][0] as {
      flagKey: string
      contextKeys: string[]
    }
    expect(second.flagKey).toBe('ab-flag')
    expect(second.contextKeys).toEqual(['user-2'])
    await client.close()
  })

  it('fires exposure with the same eventId the ingestion batch receives', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    )
    global.fetch = fetchSpy
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const exposures: Array<{ eventId?: string; eventName: string }> = []
    client.on('exposure', (event) => exposures.push(event))

    client.getFlag<string>('ab-flag', 'default', ctx('user-1'))
    await client.flush()

    expect(exposures).toHaveLength(1)
    expect(exposures[0].eventName).toBe('flag_exposure')
    expect(typeof exposures[0].eventId).toBe('string')

    const batchCall = fetchSpy.mock.calls.find((call) =>
      String(call[0]).includes('/v1/collect/batch')
    )
    const body = JSON.parse(String(batchCall?.[1]?.body)) as {
      events: Array<{ eventId: string }>
    }
    // One id everywhere, so a customer forwarding decisions to their own
    // analytics can reconcile rows against A vs B results.
    expect(body.events[0].eventId).toBe(exposures[0].eventId)
    await client.close()
  })

  it('fires configUpdate when datafile changes via refreshDatafile', async () => {
    const originalDatafile = makeDatafile()
    const updatedDatafile = makeDatafile({ publishedAt: '2024-06-15T00:00:00.000Z' })

    let callCount = 0
    global.fetch = vi.fn<typeof fetch>().mockImplementation(() => {
      callCount++
      const df = callCount <= 1 ? originalDatafile : updatedDatafile
      return Promise.resolve(
        new Response(JSON.stringify(df), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })

    const client = new AvsbServer(makeOptions())
    await client.onReady()

    const updateSpy = vi.fn()
    client.on('configUpdate', updateSpy)

    await client.refreshDatafile()

    expect(updateSpy).toHaveBeenCalledTimes(1)
    // `reason` is part of the declared payload (types.ts) and the README example:
    // it says WHICH path delivered the datafile, and `refreshDatafile()` is manual.
    expect(updateSpy.mock.calls[0][0]).toEqual({
      publishedAt: '2024-06-15T00:00:00.000Z',
      reason: 'manual',
    })
    await client.close()
  })

  it('on() returns unsubscribe function that stops listener', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const evalSpy = vi.fn()
    const unsub = client.on('evaluation', evalSpy)
    client.getFlag('test-flag', false, ctx('user-1'))
    expect(evalSpy).toHaveBeenCalledTimes(1)

    unsub()
    client.getFlag('test-flag', false, ctx('user-2'))
    expect(evalSpy).toHaveBeenCalledTimes(1) // not incremented
    await client.close()
  })

  it('off() also removes listener', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const evalSpy = vi.fn()
    client.on('evaluation', evalSpy)
    client.getFlag('test-flag', false, ctx('user-1'))
    expect(evalSpy).toHaveBeenCalledTimes(1)

    client.off('evaluation', evalSpy)
    client.getFlag('test-flag', false, ctx('user-2'))
    expect(evalSpy).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('catches listener errors without crashing the SDK', async () => {
    mockFetchSuccess()
    const logger = makeLogger()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile(), logger }))
    await client.onReady()

    const throwingListener = () => { throw new Error('listener boom') }
    client.on('evaluation', throwingListener)

    expect(() => {
      client.getFlag('test-flag', false, ctx('user-1'))
    }).not.toThrow()

    expect(logger.calls.error.length).toBeGreaterThan(0)
    const loggedData = logger.calls.error[0][1] as Record<string, unknown>
    expect(loggedData).toHaveProperty('error')
    expect(String(loggedData.error)).toContain('listener boom')
    await client.close()
  })
})

// ========================
// Shutdown
// ========================

describe('Shutdown', () => {
  it('stops polling after close', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()
    await client.close()

    const flag = client.getFlag('test-flag', false, ctx('user-1'))
    expect(flag.value).toBe(false)
    // B15: a closed client has no datafile, which is `not_ready`, not
    // `not_found`. "You asked too early or too late" and "that flag does not
    // exist" send a developer to different places.
    expect(flag.source).toBe('not_ready')
    expect(flag.exists()).toBe(false)
  })

  it('methods return defaults after close', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()
    await client.close()

    expect(client.getFlag('test-flag', 'default', ctx('u')).source).toBe('not_ready')
    expect(client.getAllFlags(ctx('u'))).toEqual({})
  })

  it('track silently queues events fired before the SDK is ready', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy
    const logger = makeLogger()
    const client = new AvsbServer(makeOptions({ logger }))

    client.track('early_event', { context: ctx('user-1'), value: 7 })

    await client.onReady()
    await client.flush()

    expect(logger.calls.warn.find((args) => String(args[0]).includes('not ready'))).toBeUndefined()
    const metricCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/metric-batch')
    )
    expect(metricCalls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(metricCalls[0][1]?.body as string)
    const earlyEvent = body.metricEvents.find((e: { eventName: string }) => e.eventName === 'early_event')
    expect(earlyEvent).toBeDefined()
    // Two columns: `value` is the metric value, `revenue` is money. This call
    // passed `value`, so money stays null rather than being invented.
    expect(earlyEvent.value).toBe(7)
    expect(earlyEvent.revenue).toBeNull()
    expect(earlyEvent.visitorId).toBe('user-1')
    await client.close()
  })
})

// ========================
// Track — new unified signature
// ========================

describe('Track', () => {
  it('queues metric event via tracker', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy

    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.track('purchase', { context: ctx('user-1') })
    await client.flush()

    const metricCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/metric-batch')
    )
    expect(metricCalls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(metricCalls[0][1]?.body as string)
    expect(body.metricEvents[0].eventName).toBe('purchase')
    expect(body.metricEvents[0].visitorId).toBe('user-1')
    await client.close()
  })

  // `revenue` and `value` are TWO columns end to end: the metric_batch wire
  // fixture declares both, and metric_events stores both as Nullable(Float64).
  // This SDK used to ship payload.value into the revenue column, so a quantity
  // was recorded as money and the value column could never be written at all.
  it('maps revenue to the revenue column and value to the value column', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy

    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.track('purchase', {
      context: ctx('user-1'),
      revenue: 99.99,
      value: 3,
    })
    await client.flush()

    const metricCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/metric-batch')
    )
    expect(metricCalls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(metricCalls[0][1]?.body as string)
    expect(body.metricEvents[0].revenue).toBe(99.99)
    expect(body.metricEvents[0].value).toBe(3)
    await client.close()
  })

  it('sends null for the column the caller did not supply', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy

    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.track('signup_completed', { context: ctx('user-1'), value: 1 })
    await client.flush()

    const metricCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/metric-batch')
    )
    const body = JSON.parse(metricCalls[0][1]?.body as string)
    // A non-revenue conversion: value carries the count, revenue is null.
    expect(body.metricEvents[0].value).toBe(1)
    expect(body.metricEvents[0].revenue).toBeNull()
    await client.close()
  })

  it('does not put properties on the metric wire, and says so once', async () => {
    // The ingestion route for /v1/collect/metric-batch builds its stored row
    // field by field with no properties column, so sending them was a promise
    // the pipeline broke. The SDK drops them and names what IS stored.
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy
    const logger = makeLogger()

    const client = new AvsbServer(
      makeOptions({ bootstrap: makeDatafile(), logger })
    )
    await client.onReady()

    client.track('purchase', {
      context: ctx('user-1'),
      value: 49.99,
      properties: { plan: 'annual', currency: 'USD', items: 3 },
    })
    client.track('signup', {
      context: ctx('user-2'),
      properties: { plan: 'free' },
    })
    await client.flush()

    const metricCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/metric-batch')
    )
    expect(metricCalls.length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(metricCalls[0][1]?.body as string)
    expect(body.metricEvents[0].properties).toBeUndefined()
    // `value` in, `value` out: the SDK used to ship it into the revenue column,
    // which recorded a quantity as money and left every average-value metric empty.
    expect(body.metricEvents[0].value).toBe(49.99)
    expect(body.metricEvents[0].revenue).toBeNull()

    const propertyWarnings = logger.calls.warn.filter((args) =>
      String(args[0]).includes('properties')
    )
    expect(propertyWarnings).toHaveLength(1)
    expect(String(propertyWarnings[0][0])).toContain('NOT stored')
    await client.close()
  })
})

// ========================
// getAllFlags — exposure suppression
// ========================

describe('getAllFlags exposure suppression', () => {
  it('suppresses exposure events by default', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.getAllFlags(ctx('user-1'))
    await client.flush()

    const exposureCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/batch')
    )
    expect(exposureCalls).toHaveLength(0)
    await client.close()
  })

  it('fires exposures when fireExposures: true is opted in', async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(makeDatafile()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    global.fetch = fetchSpy
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    client.getAllFlags(ctx('user-1'), { fireExposures: true })
    await client.flush()

    const exposureCalls = fetchSpy.mock.calls.filter(
      (call) => String(call[0]).includes('/v1/collect/batch')
    )
    expect(exposureCalls.length).toBeGreaterThanOrEqual(1)
    await client.close()
  })

  it('returns Flag objects with correct values when exposures are suppressed', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()

    const flags = client.getAllFlags(ctx('user-1'))
    expect(flags['test-flag'].value).toBe(true)
    expect(['a', 'b']).toContain(flags['ab-flag'].value)
    await client.close()
  })
})

// ========================
// Streaming wire-up
// ========================

// Streaming is DEFAULT ON for the server (B12), the endpoint comes from the
// datafile's `streamEndpoint` field (spec §1.1), and a missing endpoint falls
// back to polling in silence rather than dialling a guessed host.
describe('Streaming (default on, datafile-resolved endpoint)', () => {
  function trackedFetch(streamHostPrefix: string, datafile = makeDatafile()) {
    const seenUrls: string[] = []
    global.fetch = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input)
      seenUrls.push(url)
      if (url.startsWith(streamHostPrefix)) {
        // Ticket request that never resolves: enough to prove we dialled.
        return new Promise(() => {})
      }
      return Promise.resolve(
        new Response(JSON.stringify(datafile), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })
    return seenUrls
  }

  it('connects with no streaming option at all when the datafile carries an endpoint', async () => {
    const datafile = makeDatafile({
      streamEndpoint: 'https://app.avsb.cloud/api/sdk/stream',
    })
    const seenUrls = trackedFetch('https://app.avsb.cloud/api/sdk/stream', datafile)

    const client = new AvsbServer(makeOptions({ bootstrap: datafile }))
    await client.onReady()

    await new Promise((r) => setTimeout(r, 10))
    expect(
      seenUrls.some((u) => u.startsWith('https://app.avsb.cloud/api/sdk/stream?sdkKey='))
    ).toBe(true)
    await client.close()
  })

  it('falls back to polling in silence when no endpoint is available', async () => {
    // No streamEndpoint in the datafile and no option: the old code dialled a
    // hardcoded app host, which is exactly what a self-hosted deployment does
    // not run.
    const logger = makeLogger()
    const seenUrls = trackedFetch('https://app.avsb.cloud/api/sdk/stream')

    const client = new AvsbServer(
      makeOptions({ bootstrap: makeDatafile(), logger })
    )
    await client.onReady()
    await new Promise((r) => setTimeout(r, 10))

    expect(seenUrls.some((u) => u.includes('/api/sdk/stream'))).toBe(false)
    // Not a warning: polling still delivers changes. Debug so the reason is
    // findable when someone asks why updates are not instant.
    expect(
      logger.calls.debug.some((args) => String(args[0]).includes('Streaming stays off'))
    ).toBe(true)
    // No error either: a missing endpoint is not a failure.
    expect(logger.calls.error).toHaveLength(0)
    await client.close()
  })

  it('does not connect when streaming is explicitly false, even with an endpoint', async () => {
    const datafile = makeDatafile({
      streamEndpoint: 'https://app.avsb.cloud/api/sdk/stream',
    })
    const seenUrls = trackedFetch('https://app.avsb.cloud/api/sdk/stream', datafile)

    const client = new AvsbServer(
      makeOptions({ bootstrap: datafile, streaming: false })
    )
    await client.onReady()
    await new Promise((r) => setTimeout(r, 10))

    expect(seenUrls.some((u) => u.includes('/api/sdk/stream'))).toBe(false)
    await client.close()
  })

  it('lets an explicit streamingEndpoint override the datafile field', async () => {
    const datafile = makeDatafile({
      streamEndpoint: 'https://app.avsb.cloud/api/sdk/stream',
    })
    const seenUrls = trackedFetch('https://stream.example.com/', datafile)

    const client = new AvsbServer(
      makeOptions({
        bootstrap: datafile,
        streamingEndpoint: 'https://stream.example.com/stream',
      })
    )
    await client.onReady()
    await new Promise((r) => setTimeout(r, 10))

    expect(seenUrls.some((u) => u.startsWith('https://stream.example.com/stream'))).toBe(true)
    expect(seenUrls.some((u) => u.startsWith('https://app.avsb.cloud/api/sdk/stream'))).toBe(false)
    await client.close()
  })

  it('starts streaming after a republish adds the endpoint mid-process', async () => {
    const withEndpoint = makeDatafile({
      publishedAt: '2024-06-15T00:00:00.000Z',
      streamEndpoint: 'https://app.avsb.cloud/api/sdk/stream',
    })
    const seenUrls: string[] = []
    global.fetch = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = String(input)
      seenUrls.push(url)
      if (url.includes('/api/sdk/stream')) return new Promise(() => {})
      return Promise.resolve(
        new Response(JSON.stringify(withEndpoint), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    })

    // Boots on a datafile with no endpoint, so streaming starts off.
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    await client.onReady()
    expect(seenUrls.some((u) => u.includes('/api/sdk/stream'))).toBe(false)

    await client.refreshDatafile()
    await new Promise((r) => setTimeout(r, 10))

    expect(seenUrls.some((u) => u.includes('/api/sdk/stream'))).toBe(true)
    await client.close()
  })
})

// ========================
// close() aborts in-flight fetches
// ========================

describe('close() shutdown semantics', () => {
  it('aborts in-flight datafile fetches when close() is called', async () => {
    let receivedSignal: AbortSignal | undefined
    global.fetch = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      receivedSignal = init?.signal as AbortSignal | undefined
      return new Promise((_resolve, reject) => {
        receivedSignal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })

    const client = new AvsbServer(makeOptions({ initTimeout: 60_000 }))
    void client.onReady()
    await new Promise((r) => setTimeout(r, 5))
    expect(receivedSignal).toBeDefined()
    expect(receivedSignal!.aborted).toBe(false)
    await client.close()
    expect(receivedSignal!.aborted).toBe(true)
  })
})

// ========================
// InitResult.source never includes 'cache'
// ========================

describe('InitResult.source', () => {
  it('never returns the deprecated `cache` source', async () => {
    mockFetchSuccess()
    const client = new AvsbServer(makeOptions({ bootstrap: makeDatafile() }))
    const result = await client.onReady()
    expect((result.source as string)).not.toBe('cache')
    expect(['network', 'bootstrap', 'timeout', 'error']).toContain(result.source)
    await client.close()
  })
})
