// @vitest-environment node
//
// The edge SDK runs on servers, never in a browser. Under the default DOM test
// environment `location` exists, so the evaluator stamps the test page's URL on
// every exposure and the client's own request-URL fill-in never runs; on a real
// edge runtime there is no `location` at all.
// =====================================================================
// AvsbEdgeClient — reading flags: bound context, not_ready, typed getters,
// and the empty-context warning.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { EvalContext } from '@avsbhq/core'
import { AvsbEdgeClient } from './AvsbEdgeClient'
import { resetLogOnce } from './logger'
import {
  VALID_SDK_KEY,
  captureLogger,
  fetchCallTo,
  jsonBodyOf,
  jsonResponse,
  testDatafile,
} from './fixtures'

const userCtx: EvalContext = { kind: 'user', key: 'user_42' }

function bootstrapped(context?: EvalContext): AvsbEdgeClient {
  return new AvsbEdgeClient({
    sdkKey: VALID_SDK_KEY,
    datafile: testDatafile,
    context,
    logLevel: 'silent',
  })
}

beforeEach(() => {
  resetLogOnce()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ accepted: 1 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------
// Bound context (the dead contextFrom option, report 02 §5.12)
// ---------------------------------------------------------------------

describe('AvsbEdgeClient bound context', () => {
  it('evaluates against the context bound at construction with no third argument', async () => {
    const client = bootstrapped(userCtx)
    await client.init()

    expect(client.getFlag('always-on', false).value).toBe(true)
    expect(client.getContext()).toEqual(userCtx)
  })

  it('lets a positional context override the bound one for one call', async () => {
    const client = bootstrapped({ kind: 'user', key: 'someone_else' })
    await client.init()

    const flag = client.getFlag('checkout-v2', false, userCtx)

    expect(flag.value).toBe(true)
    // The bound context is untouched by the override.
    expect(client.getContext()).toEqual({ kind: 'user', key: 'someone_else' })
  })

  it('attributes the exposure to the overriding context, not the bound one', async () => {
    const client = bootstrapped({ kind: 'user', key: 'someone_else' })
    await client.init()

    client.getFlag('checkout-v2', false, userCtx)
    await client.flushEvents()

    const body = jsonBodyOf<{ events: Array<{ visitorId: string }> }>(
      fetchCallTo('/v1/collect/batch'),
    )
    expect(body.events[0].visitorId).toBe('user_42')
  })
})

// ---------------------------------------------------------------------
// not_ready (B15)
// ---------------------------------------------------------------------

describe('AvsbEdgeClient pre-init reads', () => {
  it('returns not_ready with the caller default before init', () => {
    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      context: userCtx,
      logLevel: 'silent',
    })

    const flag = client.getFlag('always-on', false)

    expect(flag.source).toBe('not_ready')
    expect(flag.value).toBe(false)
    expect(flag.exists()).toBe(false)
  })

  it('names the flag and the fix, once per key', () => {
    const logger = captureLogger()
    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, context: userCtx, logger })

    client.getFlag('always-on', false)
    client.getFlag('always-on', false)
    client.getFlag('checkout-v2', false)

    const warnings = logger.messages('warn').filter((m) => m.includes('before init()'))
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('always-on')
    expect(warnings[1]).toContain('checkout-v2')
    expect(warnings[0]).toContain('Await client.init()')
  })

  it('returns an empty map from getAllFlags and says why', () => {
    const logger = captureLogger()
    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, context: userCtx, logger })

    expect(client.getAllFlags()).toEqual({})
    // An empty map is otherwise indistinguishable from a project with no flags.
    expect(logger.said('returned an empty map rather than your flags')).toBe(true)
  })

  it('reports not_ready from a typed getter rather than a type mismatch', () => {
    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      context: userCtx,
      logLevel: 'silent',
    })

    expect(client.getBoolFlag('always-on', false).source).toBe('not_ready')
  })
})

// ---------------------------------------------------------------------
// Empty context (spec §1.2)
// ---------------------------------------------------------------------

describe('AvsbEdgeClient empty context', () => {
  it('warns once when no context was supplied at all', async () => {
    const logger = captureLogger()
    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      logger,
    })
    await client.init()

    client.getFlag('always-on', false)
    client.getFlag('checkout-v2', false)

    const warnings = logger.messages('warn').filter((m) => m.includes('no visitor identity'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('x-avsb-visitor-id')
    expect(warnings[0]).toContain('_avsb_visitor')
  })

  it('warns when a context was supplied with an empty key', async () => {
    const logger = captureLogger()
    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      context: { kind: 'user', key: '' },
      logger,
    })
    await client.init()

    client.getFlag('checkout-v2', false)

    expect(logger.said('no visitor identity')).toBe(true)
  })

  it('stays quiet when the context has a real key', async () => {
    const logger = captureLogger()
    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      context: userCtx,
      logger,
    })
    await client.init()

    client.getFlag('checkout-v2', false)

    expect(logger.said('no visitor identity')).toBe(false)
  })

  it('still evaluates, returning the default-bucket answer', async () => {
    const client = bootstrapped()
    await client.init()

    // Evaluation is not blocked: an empty key buckets everyone the same way,
    // which is what the warning explains.
    expect(client.getFlag('always-on', false).value).toBe(true)
  })
})

// ---------------------------------------------------------------------
// Typed getters (closes the "typed getters that do not exist" README row)
// ---------------------------------------------------------------------

describe('AvsbEdgeClient typed getters', () => {
  it('returns the typed value when the datafile agrees', async () => {
    const client = bootstrapped(userCtx)
    await client.init()

    expect(client.getBoolFlag('always-on', false).value).toBe(true)
    expect(client.getStringFlag('theme', 'light').value).toBe('midnight')
  })

  it('falls back to the default and names both types on a mismatch', async () => {
    const logger = captureLogger()
    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      context: userCtx,
      logger,
    })
    await client.init()

    const flag = client.getNumberFlag('theme', 25)

    expect(flag.value).toBe(25)
    expect(flag.source).toBe('not_found')
    const warning = logger.messages('warn').join('\n')
    expect(warning).toContain('theme')
    expect(warning).toContain('declared as "string"')
    expect(warning).toContain('"number" variant was requested')
  })

  it('types a json flag against the caller generic', async () => {
    const datafile = {
      ...testDatafile,
      flags: [
        {
          id: 'flag_cfg',
          key: 'api-config',
          type: 'json' as const,
          enabled: true,
          defaultVariationId: 'var_cfg',
          variations: [{ id: 'var_cfg', key: 'default', value: { timeout: 250 } }],
          overrides: [],
          rules: [],
        },
      ],
    }
    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile,
      context: userCtx,
      logLevel: 'silent',
    })
    await client.init()

    const flag = client.getJsonFlag<{ timeout: number }>('api-config', { timeout: 5000 })

    expect(flag.value.timeout).toBe(250)
  })

  it('accepts a per-call context like getFlag does', async () => {
    const client = bootstrapped({ kind: 'user', key: 'someone_else' })
    await client.init()

    expect(client.getBoolFlag('checkout-v2', false, userCtx).value).toBe(true)
  })
})

// ---------------------------------------------------------------------
// Exposure control
// ---------------------------------------------------------------------

describe('AvsbEdgeClient exposure control', () => {
  it('queues an exposure for an ab_test read', async () => {
    const client = bootstrapped(userCtx)
    await client.init()

    client.getFlag('checkout-v2', false)

    expect(client.queueSize()).toEqual({ events: 1, metricEvents: 0 })
  })

  it('queues nothing when fireExposure is false', async () => {
    const client = bootstrapped(userCtx)
    await client.init()

    client.getFlag('checkout-v2', false, undefined, { fireExposure: false })

    expect(client.queueSize().events).toBe(0)
  })

  it('fires no exposures from getAllFlags by default and does when asked', async () => {
    const client = bootstrapped(userCtx)
    await client.init()

    client.getAllFlags()
    expect(client.queueSize().events).toBe(0)

    client.getAllFlags(undefined, { fireExposures: true })
    expect(client.queueSize().events).toBe(1)
  })

  it('fills pageUrl from the request when the evaluator could not', async () => {
    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      datafile: testDatafile,
      context: userCtx,
      pageUrl: 'https://shop.example.com/checkout?step=2',
      logLevel: 'silent',
    })
    await client.init()

    client.getFlag('checkout-v2', false)
    await client.flushEvents()

    const body = jsonBodyOf<{ events: Array<{ pageUrl: string }> }>(
      fetchCallTo('/v1/collect/batch'),
    )
    // There is no `location` on a server, so the evaluator emits ''. The edge
    // client knows the request URL, which makes per-page analysis possible.
    expect(body.events[0].pageUrl).toBe('https://shop.example.com/checkout?step=2')
  })
})
