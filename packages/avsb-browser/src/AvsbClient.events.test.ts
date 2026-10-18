/**
 * `exposure` and `evaluation` on the client event bus (analytics integrations
 * §10, D-10).
 *
 * Both events have been in `@avsbhq/core`'s `ClientEventMap` (and in the docs)
 * since the SDK rewrite, and neither had ever been emitted: `client.on(
 * 'exposure', ...)` returned an unsubscribe function for a channel that stayed
 * silent forever. These tests pin that they now fire, with the payload the type
 * promises, on every path that evaluates a flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AvsbClient } from './AvsbClient'
import type { ExposureEvent, Flag, FlagDatafile } from './types'

const SDK_KEY = 'sdk_events'

const DATAFILE: FlagDatafile = {
  version: 1,
  projectType: 'FEATURE_FLAG',
  sdkKey: SDK_KEY,
  environmentKey: 'production',
  publishedAt: '2025-01-01T00:00:00Z',
  collectEndpoint: 'http://localhost:3001',
  audiences: [],
  flags: [
    {
      id: 'flag_checkout',
      key: 'checkout_redesign',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var_control',
      variations: [
        { id: 'var_control', key: 'control', value: false },
        { id: 'var_treatment', key: 'treatment', value: true },
      ],
      overrides: [],
      rules: [
        {
          id: 'rule_ab',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          // Whole population into the rule, whole rule into treatment: the
          // exposure is deterministic, so the assertions cannot pass vacuously.
          trafficAllocation: 1,
          variations: [{ variationId: 'var_treatment', percentage: 1 }],
        },
      ],
    },
  ],
}

describe('AvsbClient event bus — exposure + evaluation', () => {
  let client: AvsbClient | null = null

  beforeEach(() => {
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => true) })
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true } as Response)))
  })

  afterEach(async () => {
    if (client) await client.close()
    client = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  async function createClient(): Promise<AvsbClient> {
    const instance = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: DATAFILE,
      autoRefresh: false,
      context: { kind: 'user', key: 'visitor-1' },
    })
    await instance.onReady()
    return instance
  }

  it('emits exposure with the evaluated ids when a flag evaluation fires one', async () => {
    client = await createClient()
    const seen: ExposureEvent[] = []
    client.on('exposure', (event) => seen.push(event))

    client.getFlag('checkout_redesign', false)

    expect(seen).toHaveLength(1)
    expect(seen[0].visitorId).toBe('visitor-1')
    expect(seen[0].variationId).toBe('var_treatment')
    expect(seen[0].experimentId).toBe('rule_ab')
    expect(seen[0].properties?.flagId).toBe('flag_checkout')
    // The id our ingestion row and any third-party row both carry (D-6 Path A),
    // so a subscriber can reconcile what it sees here against either.
    expect(seen[0].eventId).toEqual(expect.any(String))
  })

  it('gives two exposures of the same flag distinct ids', async () => {
    client = await createClient()
    const seen: ExposureEvent[] = []
    client.on('exposure', (event) => seen.push(event))

    client.getFlag('checkout_redesign', false)
    client.getFlag('checkout_redesign', false)

    expect(seen).toHaveLength(2)
    expect(seen[0].eventId).not.toBe(seen[1].eventId)
  })

  it('does not emit exposure when the caller opted out of firing one', async () => {
    client = await createClient()
    const seen: ExposureEvent[] = []
    client.on('exposure', (event) => seen.push(event))

    client.getFlag('checkout_redesign', false, { fireExposure: false })
    client.getSnapshot('checkout_redesign', false)

    expect(seen).toHaveLength(0)
  })

  it('emits exposure from a bulk read only when that read opts in', async () => {
    client = await createClient()
    const seen: ExposureEvent[] = []
    client.on('exposure', (event) => seen.push(event))

    client.getAllFlags()
    expect(seen).toHaveLength(0)

    client.getAllFlags({ fireExposures: true })
    expect(seen).toHaveLength(1)
  })

  it('stops delivering exposure after the returned unsubscribe is called', async () => {
    client = await createClient()
    const seen: ExposureEvent[] = []
    const unsubscribe = client.on('exposure', (event) => seen.push(event))

    client.getFlag('checkout_redesign', false)
    unsubscribe()
    client.getFlag('checkout_redesign', false)

    expect(seen).toHaveLength(1)
  })

  it('emits evaluation with the flag and the bound context key', async () => {
    client = await createClient()
    const seen: { flagKey: string; flag: Flag; contextKeys: string[] }[] = []
    client.on('evaluation', (data) => seen.push(data))

    client.getFlag('checkout_redesign', false)

    expect(seen).toHaveLength(1)
    expect(seen[0].flagKey).toBe('checkout_redesign')
    expect(seen[0].flag.value).toBe(true)
    expect(seen[0].flag.variationKey).toBe('treatment')
    expect(seen[0].flag.source).toBe('rule')
    expect(seen[0].contextKeys).toEqual(['visitor-1'])
  })

  it('emits evaluation even when the exposure is suppressed (a read is still a decision)', async () => {
    client = await createClient()
    const flagKeys: string[] = []
    client.on('evaluation', (data) => flagKeys.push(data.flagKey))

    client.getFlag('checkout_redesign', false, { fireExposure: false })

    expect(flagKeys).toEqual(['checkout_redesign'])
  })

  it('emits evaluation for a runtime override, reporting the override as the source', async () => {
    client = await createClient()
    const seen: { flag: Flag }[] = []
    client.on('evaluation', (data) => seen.push(data))
    client.setGlobalOverride('checkout_redesign', 'control')

    client.getFlag('checkout_redesign', true)

    expect(seen).toHaveLength(1)
    expect(seen[0].flag.source).toBe('runtimeOverride')
    expect(seen[0].flag.variationKey).toBe('control')
  })

  it('stays silent on getSnapshot, which React calls on every render', async () => {
    client = await createClient()
    const seen: unknown[] = []
    client.on('evaluation', (data) => seen.push(data))

    client.getSnapshot('checkout_redesign', false)
    client.getSnapshot('checkout_redesign', false)

    expect(seen).toHaveLength(0)
  })

  it('reports every context identity under multi-context', async () => {
    client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: DATAFILE,
      autoRefresh: false,
      context: {
        kind: 'multi',
        user: { kind: 'user', key: 'visitor-1' },
        organization: { kind: 'organization', key: 'acme' },
      },
    })
    await client.onReady()
    const seen: string[][] = []
    client.on('evaluation', (data) => seen.push(data.contextKeys))

    client.getFlag('checkout_redesign', false)

    expect(seen).toHaveLength(1)
    expect([...seen[0]].sort()).toEqual(['acme', 'visitor-1'])
  })

  it('emits neither event before the SDK is ready', () => {
    const notReady = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      context: { kind: 'user', key: 'visitor-1' },
    })
    const seen: string[] = []
    notReady.on('evaluation', () => seen.push('evaluation'))
    notReady.on('exposure', () => seen.push('exposure'))

    const flag = notReady.getFlag('checkout_redesign', false)

    expect(flag.value).toBe(false)
    expect(seen).toEqual([])
  })

  it('keeps evaluating when a subscriber throws', async () => {
    client = await createClient()
    client.on('exposure', () => {
      throw new Error('subscriber blew up')
    })

    const flag = client.getFlag('checkout_redesign', false)

    expect(flag.value).toBe(true)
  })
})
