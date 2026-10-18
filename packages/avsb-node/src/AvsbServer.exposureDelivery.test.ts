// =====================================================================
// Exposure delivery, mirroring the production smoke sequence.
//
// The first smoke run against staging saw a correct evaluation and a correct
// conversion POST, but no POST to /v1/collect/batch at all. The cause was the
// smoke org's rule TYPE, not this SDK: a `targeted_delivery` rule fires no
// exposure by design (a one-arm rollout has nothing to compare), which
// `packages/avsb-core/src/evaluate.ts` pins with its own test. The fixture is
// being migrated to an `ab_test` rule weighted 100/0.
//
// These tests lock the delivery path so the next failure of this shape is
// unambiguous. `deliveryFixture()` is the migrated smoke fixture: an ab_test
// rule sending everything to `on` with a zero-weight `off` arm, which is
// deterministic for every visitor (cumulative reaches 10000 on the first arm,
// so the 0-weight arm can never win).
// =====================================================================

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlagDatafile } from '@avsbhq/core'
import { AvsbServer } from './AvsbServer'

const SDK_KEY = 'sdk_production_smokedelivery01'
const COLLECT_ORIGIN = 'https://collect.test.invalid'
const BATCH_URL = `${COLLECT_ORIGIN}/v1/collect/batch`
const METRIC_URL = `${COLLECT_ORIGIN}/v1/collect/metric-batch`

type RuleType = 'ab_test' | 'targeted_delivery'

/** The smoke fixture's flag, parameterised by rule type. */
function deliveryFixture(ruleType: RuleType = 'ab_test'): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
    publishedAt: '2026-08-01T00:00:00.000Z',
    collectEndpoint: COLLECT_ORIGIN,
    flags: [
      {
        id: 'flag-smoke',
        key: 'smoke_bool',
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
            id: 'rule-smoke',
            type: ruleType,
            enabled: true,
            audienceIds: [],
            hashAttribute: 'userId',
            trafficAllocation: ruleType === 'ab_test' ? 1 : null,
            variations:
              ruleType === 'ab_test'
                ? [
                    { variationId: 'var-on', percentage: 1 },
                    { variationId: 'var-off', percentage: 0 },
                  ]
                : [{ variationId: 'var-on', percentage: 1 }],
          },
        ],
      },
    ],
    audiences: [],
  } as unknown as FlagDatafile
}

interface CapturedPost {
  url: string
  body: unknown
}

interface Transport {
  posts: CapturedPost[]
  postsTo(url: string): CapturedPost[]
}

/**
 * Mocked transport: any GET answers with the datafile, every POST is recorded.
 * Nothing leaves the process.
 */
function installTransport(datafile: FlagDatafile | null): Transport {
  const posts: CapturedPost[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input)
      if ((init?.method ?? 'GET') === 'POST') {
        posts.push({
          url,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        })
        return new Response('{}', { status: 200 })
      }
      if (!datafile) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify(datafile), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
  )
  return {
    posts,
    postsTo: (url: string) => posts.filter((p) => p.url === url),
  }
}

function readEvents(post: CapturedPost | undefined): unknown[] {
  const body = post?.body as { events?: unknown[] } | undefined
  return body?.events ?? []
}

function readMetricEvents(post: CapturedPost | undefined): unknown[] {
  const body = post?.body as { metricEvents?: unknown[] } | undefined
  return body?.metricEvents ?? []
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AvsbServer exposure delivery', () => {
  it('delivers one exposure and one conversion for the smoke sequence', async () => {
    const transport = installTransport(deliveryFixture('ab_test'))
    const client = new AvsbServer({
      sdkKey: SDK_KEY,
      cdnHost: 'https://cdn.test.invalid',
      initTimeout: 5_000,
      logLevel: 'silent',
    })

    try {
      const init = await client.onReady()
      expect(init.success).toBe(true)
      expect(init.source).toBe('network')

      const context = { kind: 'user', key: 'smoke-visitor-1' } as const
      const flag = client.getBoolFlag('smoke_bool', false, context)
      expect(flag.value).toBe(true)
      expect(flag.variationKey).toBe('on')

      client.track('smoke_converted', { context, value: 1 })
      await client.flush()

      const batchPosts = transport.postsTo(BATCH_URL)
      const metricPosts = transport.postsTo(METRIC_URL)
      expect(batchPosts).toHaveLength(1)
      expect(metricPosts).toHaveLength(1)

      const exposures = readEvents(batchPosts[0])
      expect(exposures).toHaveLength(1)
      expect(exposures[0]).toMatchObject({
        visitorId: 'smoke-visitor-1',
        experimentId: 'rule-smoke',
        variationId: 'var-on',
        eventName: 'flag_exposure',
      })

      const metrics = readMetricEvents(metricPosts[0])
      expect(metrics).toHaveLength(1)
      expect(metrics[0]).toMatchObject({
        visitorId: 'smoke-visitor-1',
        eventName: 'smoke_converted',
        value: 1,
      })
    } finally {
      await client.close()
    }
  })

  // Pins the DESIGN the smoke run tripped over, so nobody "fixes" the SDK for
  // it again. A rollout rule serves a variation without running an experiment,
  // so there is no assignment to record.
  it('fires no exposure for a targeted_delivery rule, but still delivers the conversion', async () => {
    const transport = installTransport(deliveryFixture('targeted_delivery'))
    const client = new AvsbServer({
      sdkKey: SDK_KEY,
      cdnHost: 'https://cdn.test.invalid',
      initTimeout: 5_000,
      logLevel: 'silent',
    })

    try {
      await client.onReady()
      const context = { kind: 'user', key: 'smoke-visitor-2' } as const
      expect(client.getBoolFlag('smoke_bool', false, context).value).toBe(true)
      client.track('smoke_converted', { context, value: 1 })
      await client.flush()

      expect(transport.postsTo(BATCH_URL)).toHaveLength(0)
      expect(transport.postsTo(METRIC_URL)).toHaveLength(1)
    } finally {
      await client.close()
    }
  })

  // A bootstrapped client is READY on the constructing tick, so it must be able
  // to DELIVER on that tick. Before the tracker was built in the constructor,
  // this sequence sent nothing at all: the exposure hit `this.tracker?.queue()`
  // and vanished, and the conversion sat in the pre-ready queue that only
  // tracker creation drains.
  it('delivers from a bootstrapped client that never awaits onReady', async () => {
    const transport = installTransport(null)
    const client = new AvsbServer({
      sdkKey: SDK_KEY,
      cdnHost: 'https://cdn.test.invalid',
      logLevel: 'silent',
      bootstrap: deliveryFixture('ab_test'),
    })

    try {
      expect(client.isReady()).toBe(true)
      const context = { kind: 'user', key: 'smoke-visitor-3' } as const
      expect(client.getBoolFlag('smoke_bool', false, context).value).toBe(true)
      client.track('smoke_converted', { context, value: 1 })
      await client.flush()

      expect(readEvents(transport.postsTo(BATCH_URL)[0])).toHaveLength(1)
      expect(readMetricEvents(transport.postsTo(METRIC_URL)[0])).toHaveLength(1)
    } finally {
      await client.close()
    }
  })

  // The buffer behind `deliverExposure`. An exposure produced while no tracker
  // exists is held and drained on creation, never dropped: a lost exposure
  // takes a visitor out of the DENOMINATOR, so the experiment keeps reporting a
  // rate that is quietly wrong.
  it('drains an exposure that was produced before the tracker existed', async () => {
    const transport = installTransport(null)
    const client = new AvsbServer({
      sdkKey: SDK_KEY,
      cdnHost: 'https://cdn.test.invalid',
      logLevel: 'silent',
      bootstrap: deliveryFixture('ab_test'),
    })

    try {
      // Reach the private buffer the way a broken lifecycle path would: no
      // tracker, but a datafile that answers and an exposure already fired.
      const internals = client as unknown as {
        tracker: unknown
        deliverExposure(event: Record<string, unknown>): void
        initTracker(): void
      }
      internals.tracker = null
      internals.deliverExposure({
        visitorId: 'smoke-visitor-4',
        experimentId: 'rule-smoke',
        variationId: 'var-on',
        eventName: 'flag_exposure',
        revenue: null,
        timestamp: Date.now(),
        pageUrl: '',
        properties: {},
      })
      expect(transport.postsTo(BATCH_URL)).toHaveLength(0)

      internals.initTracker()
      await client.flush()

      const exposures = readEvents(transport.postsTo(BATCH_URL)[0])
      expect(exposures).toHaveLength(1)
      expect(exposures[0]).toMatchObject({ visitorId: 'smoke-visitor-4' })
    } finally {
      await client.close()
    }
  })

  // `refreshDatafile` used to load a datafile without completing the readiness
  // transition, so flags kept answering "not_ready" and no tracker was built.
  it('becomes ready and delivers after a manual refreshDatafile', async () => {
    const transport = installTransport(deliveryFixture('ab_test'))
    const client = new AvsbServer({
      sdkKey: SDK_KEY,
      cdnHost: 'https://cdn.test.invalid',
      logLevel: 'silent',
    })

    try {
      expect(client.isReady()).toBe(false)
      await client.refreshDatafile()
      expect(client.isReady()).toBe(true)

      const context = { kind: 'user', key: 'smoke-visitor-5' } as const
      expect(client.getBoolFlag('smoke_bool', false, context).value).toBe(true)
      await client.flush()

      expect(readEvents(transport.postsTo(BATCH_URL)[0])).toHaveLength(1)
    } finally {
      await client.close()
    }
  })
})
