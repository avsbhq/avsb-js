/**
 * The browser client contract the seven framework adapters build on
 * (spec §4 item 6, report 02 §5.3-5.5, report 03 handoff list).
 *
 * These are the bugs mocks hid. Every adapter was written against
 * `subscribe` + `getSnapshot` + typed getters, and every one of those
 * behaviours was asserted through a hand-written fake client that DID
 * cache its snapshots and DID notify on ready, so the adapters' tests
 * passed while the real client failed both. Everything below drives the
 * REAL AvsbClient.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AvsbClient } from './AvsbClient'
import type { FlagDatafile, Logger, Tracker } from './types'
import * as trackerModule from './tracker'
import { writeCachedDatafile } from './datafileCache'

const SDK_KEY = 'sdk_production_contract000000000000'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Two flags: `plan_gate` is audience driven (so a context change flips it)
 * and `always_on` never moves (so it is the control for per-key snapshot
 * stability).
 */
function datafile(overrides?: Partial<FlagDatafile>): FlagDatafile {
  return {
    version: 1,
    projectType: 'FEATURE_FLAG',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
    publishedAt: '2026-01-01T00:00:00Z',
    collectEndpoint: 'https://collect.test.invalid',
    audiences: [
      {
        id: 'aud_pro',
        rules: {
          id: 'g1',
          logic: 'AND',
          conditions: [
            {
              id: 'c1',
              type: 'CUSTOM_ATTRIBUTE',
              attribute: 'plan',
              operator: 'equals',
              value: 'pro',
            },
          ],
        },
      },
    ],
    flags: [
      {
        id: 'f_plan',
        key: 'plan_gate',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'v_off',
        variations: [
          { id: 'v_off', key: 'off', value: false },
          { id: 'v_on', key: 'on', value: true },
        ],
        overrides: [],
        rules: [
          {
            id: 'r_plan',
            type: 'ab_test',
            enabled: true,
            audienceIds: ['aud_pro'],
            hashAttribute: 'userId',
            trafficAllocation: 1,
            variations: [{ variationId: 'v_on', percentage: 1 }],
          },
        ],
      },
      {
        id: 'f_always',
        key: 'always_on',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'v_off2',
        variations: [
          { id: 'v_off2', key: 'off', value: false },
          { id: 'v_on2', key: 'on', value: true },
        ],
        overrides: [],
        rules: [
          {
            id: 'r_always',
            type: 'targeted_delivery',
            enabled: true,
            audienceIds: [],
            hashAttribute: 'userId',
            trafficAllocation: null,
            variations: [{ variationId: 'v_on2', percentage: 1 }],
          },
        ],
      },
    ],
    ...overrides,
  }
}

function trackerSpy(): { tracker: Tracker; queue: ReturnType<typeof vi.fn>; queueMetric: ReturnType<typeof vi.fn> } {
  const queue = vi.fn()
  const queueMetric = vi.fn()
  const tracker: Tracker = {
    queue,
    queueMetric,
    flush: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
  vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
  return { tracker, queue, queueMetric }
}

function spyLogger(): Logger & { calls: { level: string; message: string }[] } {
  const calls: { level: string; message: string }[] = []
  const logger: Logger & { calls: { level: string; message: string }[] } = {
    calls,
    debug: (m: string) => calls.push({ level: 'debug', message: m }),
    info: (m: string) => calls.push({ level: 'info', message: m }),
    warn: (m: string) => calls.push({ level: 'warn', message: m }),
    error: (m: string) => calls.push({ level: 'error', message: m }),
    child: () => logger,
  }
  return logger
}

interface FetchCall {
  url: string
  init?: RequestInit
}

/** Minimal fetch double that records calls and answers with a queue. */
function mockFetch(
  responses: Array<
    | { status?: number; body?: unknown; etag?: string | null }
    | { throws: Error }
    | 'never'
  >,
): FetchCall[] {
  const calls: FetchCall[] = []
  let index = 0
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const answer = responses[Math.min(index, responses.length - 1)]
    index += 1
    if (answer === 'never') return new Promise(() => undefined)
    if ('throws' in answer) return Promise.reject(answer.throws)
    const status = answer.status ?? 200
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? answer.etag ?? null : null) },
      json: () => Promise.resolve(answer.body),
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Snapshot contract
// ---------------------------------------------------------------------------

describe('AvsbClient — snapshot contract', () => {
  it('returns the identical Flag object across repeated getSnapshot calls', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    await client.onReady()

    const first = client.getSnapshot('plan_gate', false)
    const second = client.getSnapshot('plan_gate', false)

    // React compares snapshots by identity. A fresh frozen Flag per call is
    // the "getSnapshot should be cached to avoid an infinite loop" error.
    expect(second).toBe(first)
    expect(first.value).toBe(true)
    await client.close()
  })

  it('keeps an unrelated flag stable when another flag changes', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'free' },
    })
    await client.onReady()

    const alwaysBefore = client.getSnapshot('always_on', false)
    const gateBefore = client.getSnapshot('plan_gate', false)
    expect(gateBefore.value).toBe(false)

    client.identify({ kind: 'user', key: 'u1', plan: 'pro' })

    expect(client.getSnapshot('plan_gate', false).value).toBe(true)
    expect(client.getSnapshot('plan_gate', false)).not.toBe(gateBefore)
    // Invalidation is per key: the flag that did not move keeps its object,
    // so a component subscribed to it does not re-render.
    expect(client.getSnapshot('always_on', false)).toBe(alwaysBefore)
    await client.close()
  })

  it('reports not_ready before the datafile lands and the real value after', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })

    const before = client.getSnapshot('plan_gate', false)
    expect(before.source).toBe('not_ready')
    expect(before.value).toBe(false)
    expect(client.isReady()).toBe(false)

    await client.onReady()

    const after = client.getSnapshot('plan_gate', false)
    expect(after.source).toBe('rule')
    expect(after.value).toBe(true)
    expect(client.isReady()).toBe(true)
    await client.close()
  })

  it('carries real reasons on every evaluation', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    await client.onReady()

    // The evaluator only fills a caller-supplied array, and the browser used
    // to pass none, so `flag.reasons` was permanently empty here while node's
    // was real (report 02 §5.8).
    expect(client.getFlag('plan_gate', false).reasons.length).toBeGreaterThan(0)
    expect(client.getSnapshot('plan_gate', false).reasons.length).toBeGreaterThan(0)
    expect(client.getAllFlags()['plan_gate']?.reasons.length).toBeGreaterThan(0)
    await client.close()
  })

  it('returns a stable object from getAllFlags until something changes', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'free' },
    })
    await client.onReady()

    const first = client.getAllFlags()
    expect(client.getAllFlags()).toBe(first)

    client.identify({ kind: 'user', key: 'u1', plan: 'pro' })
    expect(client.getAllFlags()).not.toBe(first)
    await client.close()
  })
})

// ---------------------------------------------------------------------------
// Subscriber notification
// ---------------------------------------------------------------------------

describe('AvsbClient — subscriber notification', () => {
  it('wakes every subscriber on the ready transition', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })

    const gate = vi.fn()
    const always = vi.fn()
    const missing = vi.fn()
    client.subscribe('plan_gate', gate)
    client.subscribe('always_on', always)
    client.subscribe('not_in_datafile', missing)

    await client.onReady()

    // Before this fix, initialize() built the flag cache and notified nobody:
    // a hook that mounted during init rendered defaults forever.
    expect(gate).toHaveBeenCalledTimes(1)
    expect(always).toHaveBeenCalledTimes(1)
    // Including keys the datafile does not carry: their answer moved from
    // not_ready to not_found.
    expect(missing).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('notifies only the subscribers of flags whose value changed', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'free' },
    })
    await client.onReady()

    const gate = vi.fn()
    const always = vi.fn()
    client.subscribe('plan_gate', gate)
    client.subscribe('always_on', always)

    client.identify({ kind: 'user', key: 'u1', plan: 'pro' })

    expect(gate).toHaveBeenCalledTimes(1)
    expect(always).not.toHaveBeenCalled()
    await client.close()
  })

  it('stops notifying after unsubscribe', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'free' },
    })
    await client.onReady()

    const listener = vi.fn()
    const unsubscribe = client.subscribe('plan_gate', listener)
    client.identify({ kind: 'user', key: 'u1', plan: 'pro' })
    unsubscribe()
    client.identify({ kind: 'user', key: 'u1', plan: 'free' })

    expect(listener).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('keeps notifying the rest when one subscriber throws', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'free' },
      logLevel: 'silent',
    })
    await client.onReady()

    const good = vi.fn()
    client.subscribe('plan_gate', () => {
      throw new Error('subscriber blew up')
    })
    client.subscribe('plan_gate', good)

    expect(() =>
      client.identify({ kind: 'user', key: 'u1', plan: 'pro' }),
    ).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    await client.close()
  })
})

// ---------------------------------------------------------------------------
// Overrides on keys the datafile does not carry
// ---------------------------------------------------------------------------

describe('AvsbClient — overriding a key the datafile does not carry', () => {
  it('swaps the snapshot and notifies subscribers, then reverts on clear', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    await client.onReady()

    const listener = vi.fn()
    const changed: string[] = []
    client.subscribe('not_in_datafile', listener)
    client.on('flagChange', (data) => changed.push(data.flagKey))

    const before = client.getSnapshot('not_in_datafile', false)
    expect(before.source).toBe('not_found')

    // A QA override for a flag that has not shipped yet. `getFlag` answers it
    // from the override store, so the snapshot and the subscribers have to move
    // with it. The value cache used to iterate only `datafile.flags`, which made
    // this key invisible to invalidation: `getSnapshot` kept serving the stale
    // not_found object while `getFlag` returned the override.
    client.setGlobalOverride('not_in_datafile', 'on')

    expect(listener).toHaveBeenCalledTimes(1)
    expect(changed).toContain('not_in_datafile')
    const after = client.getSnapshot('not_in_datafile', false)
    expect(after).not.toBe(before)
    expect(after.source).toBe('runtimeOverride')
    expect(after.variationKey).toBe('on')
    // The live read and the cached snapshot must agree.
    expect(client.getFlag('not_in_datafile', false).source).toBe('runtimeOverride')

    client.clearGlobalOverride('not_in_datafile')

    expect(listener).toHaveBeenCalledTimes(2)
    const reverted = client.getSnapshot('not_in_datafile', false)
    expect(reverted).not.toBe(after)
    expect(reverted.source).toBe('not_found')
    expect<unknown>(reverted.value).toBe(false)
    await client.close()
  })

  it('leaves an override that does not apply to this context invisible', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    await client.onReady()

    const listener = vi.fn()
    client.subscribe('not_in_datafile', listener)
    const before = client.getSnapshot('not_in_datafile', false)

    // Scoped to a different visitor, so nothing changed for this one. The
    // store entry exists but resolves to null, which must not register as a
    // change.
    client.setOverrideForUser('not_in_datafile', 'someone_else', 'on')

    expect(listener).not.toHaveBeenCalled()
    expect(client.getSnapshot('not_in_datafile', false)).toBe(before)
    await client.close()
  })
})

// ---------------------------------------------------------------------------
// Read-only mode
// ---------------------------------------------------------------------------

describe('AvsbClient — read-only reads', () => {
  it('fires no exposure and no evaluation event in readOnly mode', async () => {
    const { queue } = trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    await client.onReady()

    const evaluations = vi.fn()
    client.on('evaluation', evaluations)

    client.getBoolFlag('plan_gate', false, { readOnly: true })
    client.getSnapshot('plan_gate', false)
    client.getFlag('plan_gate', false, { readOnly: true })

    // Render paths must not write exposure data: React renders are retried,
    // discarded, and replayed, so a render is not a decision.
    expect(queue).not.toHaveBeenCalled()
    expect(evaluations).not.toHaveBeenCalled()

    client.getBoolFlag('plan_gate', false)
    expect(queue).toHaveBeenCalledTimes(1)
    expect(evaluations).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('returns stable objects from typed getters in readOnly mode', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    await client.onReady()

    const first = client.getBoolFlag('plan_gate', false, { readOnly: true })
    expect(client.getBoolFlag('plan_gate', false, { readOnly: true })).toBe(first)
    // The generic getter keeps its own entry, since a typed getter can
    // substitute the default after its type check.
    expect(client.getSnapshot('plan_gate', false)).not.toBe(first)
    await client.close()
  })

  it('honours DISABLE_EXPOSURE as an alternative to fireExposure false', async () => {
    const { queue } = trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    await client.onReady()

    client.getFlag('plan_gate', false, { decideOptions: ['DISABLE_EXPOSURE'] })
    expect(queue).not.toHaveBeenCalled()

    client.getFlag('plan_gate', false, { fireExposure: false })
    expect(queue).not.toHaveBeenCalled()

    client.getFlag('plan_gate', false)
    expect(queue).toHaveBeenCalledTimes(1)
    await client.close()
  })
})

// ---------------------------------------------------------------------------
// Init results, cache-then-network, ETag
// ---------------------------------------------------------------------------

describe('AvsbClient — init results', () => {
  it('starts loading from the constructor, with no onReady call', async () => {
    trackerSpy()
    const calls = mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })

    // A missed `await onReady()` used to mean flags never worked at all.
    await vi.waitFor(() => expect(client.isReady()).toBe(true))
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`https://cdn.avsb.cloud/${SDK_KEY}/datafile.json`)
    await client.close()
  })

  it('does not touch the network when autoInit is off', async () => {
    const calls = mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoInit: false,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    await Promise.resolve()
    expect(calls).toHaveLength(0)
    await client.close()
  })

  it('serves a cached datafile synchronously and updates when the network answers', async () => {
    trackerSpy()
    const stale = datafile({ publishedAt: '2025-01-01T00:00:00Z' })
    // A cached datafile where the gate flag is off for everyone.
    stale.flags[0].rules = []
    writeCachedDatafile(SDK_KEY, { datafile: stale, etag: 'etag-v1' })
    mockFetch([{ body: datafile(), etag: 'etag-v2' }])

    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })

    // Readable on the first tick: this is the instant second load.
    expect(client.isReady()).toBe(true)
    expect(client.getFlag('plan_gate', false).value).toBe(false)
    expect(client.getInitResult()).toBeNull()

    const listener = vi.fn()
    client.subscribe('plan_gate', listener)

    const result = await client.onReady()

    expect(result).toEqual({ success: true, source: 'network' })
    expect(client.getFlag('plan_gate', false).value).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('sends If-None-Match from the cached ETag and keeps serving on a 304', async () => {
    trackerSpy()
    writeCachedDatafile(SDK_KEY, { datafile: datafile(), etag: 'etag-v1' })
    const calls = mockFetch([{ status: 304, etag: 'etag-v1' }])

    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    const result = await client.onReady()

    const headers = calls[0].init?.headers as Record<string, string> | undefined
    expect(headers?.['If-None-Match']).toBe('etag-v1')
    // A 304 costs no body, which is the CDN egress win, and the cached
    // datafile stays authoritative.
    expect(result.success).toBe(true)
    expect(client.getFlag('plan_gate', false).value).toBe(true)
    await client.close()
  })

  it('omits If-None-Match when there is nothing cached', async () => {
    trackerSpy()
    const calls = mockFetch([{ body: datafile() }])

    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })
    await client.onReady()

    const headers = calls[0].init?.headers as Record<string, string> | undefined
    expect(headers?.['If-None-Match']).toBeUndefined()
    await client.close()
  })

  it('reports degraded when a refresh fails but a cached datafile is being served', async () => {
    trackerSpy()
    writeCachedDatafile(SDK_KEY, { datafile: datafile(), etag: null })
    mockFetch([{ throws: new TypeError('Failed to fetch') }])

    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      logLevel: 'silent',
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    const result = await client.onReady()

    // `degraded: true` means exactly this and nothing else (spec §1.2):
    // serving something stale after a failed refresh.
    expect(result.success).toBe(true)
    expect(result.degraded).toBe(true)
    expect(result.source).toBe('error')
    expect(client.getFlag('plan_gate', false).value).toBe(true)
    await client.close()
  })

  it('fails init loudly on a 404, naming the status, the URL, and the fix', async () => {
    const logger = spyLogger()
    mockFetch([{ status: 404 }])

    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      logger,
      context: { kind: 'user', key: 'u1' },
    })
    const result = await client.onReady()

    expect(result.success).toBe(false)
    expect(result.source).toBe('error')
    const errors = logger.calls.filter((c) => c.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('404')
    expect(errors[0].message).toContain(`${SDK_KEY}/datafile.json`)
    expect(errors[0].message).toContain('Environments')
    await client.close()
  })

  it('recovers when a later poll rescues a failed init', async () => {
    trackerSpy()
    mockFetch([{ throws: new TypeError('Failed to fetch') }, { body: datafile() }])

    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      logLevel: 'silent',
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    const failed = await client.onReady()
    expect(failed.success).toBe(false)

    const ready = vi.fn()
    client.on('ready', ready)
    await client.refresh()

    expect(client.isReady()).toBe(true)
    expect(client.getInitResult()?.success).toBe(true)
    expect(ready).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('resolves onReady({ timeout }) without waiting for a stalled fetch', async () => {
    vi.useFakeTimers()
    try {
      mockFetch(['never'])
      const client = new AvsbClient({
        sdkKey: SDK_KEY,
        autoRefresh: false,
        logLevel: 'silent',
        context: { kind: 'user', key: 'u1' },
      })

      const pending = client.onReady({ timeout: 2000 })
      await vi.advanceTimersByTimeAsync(2100)
      const result = await pending

      expect(result.success).toBe(false)
      expect(result.source).toBe('timeout')
      expect(result.error?.message).toContain('2000ms')
      expect(result.error?.message).toContain('cdn.avsb.cloud')
      await client.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a timeout as degraded when a cached datafile is already serving', async () => {
    vi.useFakeTimers()
    try {
      trackerSpy()
      writeCachedDatafile(SDK_KEY, { datafile: datafile(), etag: null })
      mockFetch(['never'])
      const client = new AvsbClient({
        sdkKey: SDK_KEY,
        autoRefresh: false,
        logLevel: 'silent',
        context: { kind: 'user', key: 'u1', plan: 'pro' },
      })

      const pending = client.onReady({ timeout: 1000 })
      await vi.advanceTimersByTimeAsync(1100)
      const result = await pending

      expect(result.success).toBe(true)
      expect(result.degraded).toBe(true)
      expect(result.source).toBe('timeout')
      await client.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a datafile request that outlives initTimeout', async () => {
    vi.useFakeTimers()
    try {
      const aborted = vi.fn()
      const fetchMock = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted()
              reject(new DOMException('The operation was aborted', 'AbortError'))
            })
          }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const client = new AvsbClient({
        sdkKey: SDK_KEY,
        autoRefresh: false,
        initTimeout: 500,
        logLevel: 'silent',
        context: { kind: 'user', key: 'u1' },
      })
      const pending = client.onReady()
      await vi.advanceTimersByTimeAsync(600)
      const result = await pending

      // Before this, onReady() could hang forever on a stalled connection.
      expect(aborted).toHaveBeenCalledTimes(1)
      expect(result.success).toBe(false)
      expect(result.error?.message).toContain('timed out after 500ms')
      await client.close()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Loudness at construction
// ---------------------------------------------------------------------------

describe('AvsbClient — loud construction', () => {
  it('logs an actionable error for a key that is not shaped like an SDK key', () => {
    const logger = spyLogger()
    mockFetch([{ body: datafile() }])

    const client = new AvsbClient({
      sdkKey: 'sdk-pub-your-key-here',
      autoInit: false,
      logger,
      context: { kind: 'user', key: 'u1' },
    })

    const errors = logger.calls.filter((c) => c.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('does not look like an SDK key')
    expect(errors[0].message).toContain('Environments')
    void client
  })

  it('says nothing about a well-formed key', () => {
    const logger = spyLogger()
    mockFetch([{ body: datafile() }])

    new AvsbClient({
      sdkKey: SDK_KEY,
      autoInit: false,
      logger,
      context: { kind: 'user', key: 'u1' },
    })

    expect(logger.calls.filter((c) => c.level === 'error')).toHaveLength(0)
  })

  it('warns once, not per call, when flags are read before the datafile lands', () => {
    const logger = spyLogger()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoInit: false,
      logger,
      context: { kind: 'user', key: 'u1' },
    })

    for (let i = 0; i < 5; i++) client.getSnapshot('plan_gate', false)

    const warnings = logger.calls.filter(
      (c) => c.level === 'warn' && c.message.includes('plan_gate'),
    )
    // A render loop must not flood the console.
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('onReady')
  })

  it('warns instead of silently returning an empty map from getAllFlags', () => {
    const logger = spyLogger()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoInit: false,
      logger,
      context: { kind: 'user', key: 'u1' },
    })

    expect(client.getAllFlags()).toEqual({})
    const warnings = logger.calls.filter((c) => c.message.includes('getAllFlags'))
    expect(warnings).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Identity and context handling
// ---------------------------------------------------------------------------

describe('AvsbClient — identity', () => {
  it('reuses the persisted anonymous id across clients, and rotates it on reset', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])

    const first = new AvsbClient({ sdkKey: SDK_KEY, autoRefresh: false })
    const firstKey = (first.getContext() as { key: string }).key
    expect(firstKey.startsWith('anon_')).toBe(true)

    // A second page load must bucket the same visitor. The old per-load key
    // re-bucketed anonymous traffic on every navigation.
    const second = new AvsbClient({ sdkKey: SDK_KEY, autoRefresh: false })
    expect((second.getContext() as { key: string }).key).toBe(firstKey)

    second.reset()
    const afterReset = (second.getContext() as { key: string }).key
    expect(afterReset).not.toBe(firstKey)

    // And the rotation is persisted, so the next load is the new visitor.
    const third = new AvsbClient({ sdkKey: SDK_KEY, autoRefresh: false })
    expect((third.getContext() as { key: string }).key).toBe(afterReset)

    await Promise.all([first.close(), second.close(), third.close()])
  })

  it('evaluates getAllFlags against a requested context without rebinding', async () => {
    trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'free' },
    })
    await client.onReady()

    const forPro = client.getAllFlags({
      context: { kind: 'user', key: 'u2', plan: 'pro' },
    })

    // Report 02 §5.29: the context argument used to be dropped, so a
    // server-produced snapshot for user A could return user B's values.
    expect(forPro['plan_gate']?.value).toBe(true)
    expect(client.getAllFlags()['plan_gate']?.value).toBe(false)
    expect((client.getContext() as { key: string }).key).toBe('u1')
    await client.close()
  })
})

// ---------------------------------------------------------------------------
// Pre-ready event queue
// ---------------------------------------------------------------------------

describe('AvsbClient — pre-ready track queue', () => {
  it('flushes events queued before the tracker existed', async () => {
    const { queueMetric } = trackerSpy()
    mockFetch([{ body: datafile() }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1' },
    })

    client.track('signup')
    expect(queueMetric).not.toHaveBeenCalled()

    await client.onReady()
    expect(queueMetric).toHaveBeenCalledTimes(1)
    expect(queueMetric.mock.calls[0][0].eventName).toBe('signup')
    await client.close()
  })

  it('bounds the queue and warns once when a client never becomes ready', async () => {
    const logger = spyLogger()
    mockFetch([{ throws: new TypeError('Failed to fetch') }])
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      maxPendingEvents: 2,
      logger,
      context: { kind: 'user', key: 'u1' },
    })
    await client.onReady()

    for (let i = 0; i < 10; i++) client.track(`event_${i}`)

    // The queue used to be unbounded: a busy SPA with a wrong key grew it
    // forever (report 02 §5.30).
    const warnings = logger.calls.filter((c) => c.message.includes('waiting for the SDK'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('maxPendingEvents')
    await client.close()
  })
})
