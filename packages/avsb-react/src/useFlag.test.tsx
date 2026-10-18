/**
 * The store contract, driven by the REAL browser client.
 *
 * WHY THE REAL CLIENT: the previous version of this file injected a
 * hand-written caching mock, and that mock is the reason a whole release
 * shipped with hooks that could not render a flag. The mock returned
 * stable objects; `AvsbClient.getSnapshot` returned a fresh frozen `Flag`
 * on every call, so React's `useSyncExternalStore` re-rendered forever.
 * Only the real client can catch that class of bug, so these tests drive
 * it directly.
 *
 * The client is imported by relative path rather than by package
 * specifier: `@avsbhq/browser` resolves to that package's BUILD output,
 * which would let a stale dist quietly pass tests written against the
 * current contract.
 *
 * Nothing here asserts markup. The probes render `null`; what is measured
 * is render counts, snapshot identity, and side effects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement, type ReactElement, type ReactNode } from 'react'
import type { Flag, FlagDatafile } from '@avsbhq/core'
import { AvsbClient } from '../../avsb-browser/src/AvsbClient'
import type { Tracker } from '../../avsb-browser/src/types'
import * as trackerModule from '../../avsb-browser/src/tracker'
import { createFlag } from '@avsbhq/core'
import { AvsbProvider } from './AvsbProvider'
import { toSerializedFlagMap } from './serverFlags'
import { useFlag } from './useFlag'
import { useAllFlags } from './useAllFlags'

const SDK_KEY = 'sdk_production_reacthooks000000'

function datafile(): FlagDatafile {
  return {
    version: 2,
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
        id: 'f_gate',
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
        id: 'f_other',
        key: 'other_flag',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'v_off2',
        variations: [{ id: 'v_off2', key: 'off', value: false }],
        overrides: [],
        rules: [],
      },
    ],
  }
}

function stubTracker(): ReturnType<typeof vi.fn> {
  const queue = vi.fn()
  const tracker: Tracker = {
    queue,
    queueMetric: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
  vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
  return queue
}

/**
 * Hold the datafile response.
 *
 * The provider awaits `client.onReady()`, and that STARTS init on an
 * `autoInit: false` client, so the `beforeEach` stub would hand the
 * datafile over inside the very first `act()` and nothing would ever be
 * unreadable. Holding the response is what makes "flags have not arrived
 * yet" true for the whole first render pass; `fail` settles it the way an
 * offline browser would.
 */
function holdDatafile(): { fail: (error: Error) => void } {
  let rejectFetch: (error: Error) => void = () => undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectFetch = reject
        }),
    ),
  )
  return { fail: (error: Error) => rejectFetch(error) }
}

function makeClient(options?: { autoInit?: boolean; plan?: string }): AvsbClient {
  return new AvsbClient({
    sdkKey: SDK_KEY,
    context: { kind: 'user', key: 'u1', plan: options?.plan ?? 'pro' },
    ...(options?.autoInit === false ? { autoInit: false } : { bootstrap: datafile() }),
    autoRefresh: false,
    cache: false,
    logLevel: 'silent',
  })
}

function wrap(client: AvsbClient, children: ReactNode): ReactElement {
  return createElement(AvsbProvider, { client, children })
}

/** The same tree, plus the values a server render already produced. */
function wrapWithServerFlags(
  client: AvsbClient,
  serverFlags: unknown,
  children: ReactNode,
): ReactElement {
  return createElement(AvsbProvider, { client, serverFlags, children } as never)
}

interface Probe {
  component: () => null
  renders: () => number
  seen: () => Flag<boolean>[]
}

function makeProbe(flagKey: string): Probe {
  let renders = 0
  const seen: Flag<boolean>[] = []
  function ProbeComponent(): null {
    renders += 1
    seen.push(useFlag(flagKey, false))
    return null
  }
  return { component: ProbeComponent, renders: () => renders, seen: () => seen }
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // React reports "The result of getSnapshot should be cached to avoid an
  // infinite loop" through console.error, so every test also asserts that
  // React stayed quiet.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve(datafile()),
      }),
    ),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useFlag against the real client', () => {
  it('renders a bounded number of times and keeps one stable snapshot', async () => {
    stubTracker()
    const client = makeClient()
    await client.onReady()

    const probe = makeProbe('plan_gate')
    await act(async () => {
      render(wrap(client, createElement(probe.component)))
    })

    expect(probe.renders()).toBeLessThanOrEqual(3)
    const seen = probe.seen()
    expect(seen.length).toBeGreaterThan(0)
    for (const snapshot of seen) expect(snapshot).toBe(seen[0])
    expect(seen[0].value).toBe(true)
    expect(seen[0].source).toBe('rule')
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })

  it('wakes a component that mounted before the datafile arrived', async () => {
    stubTracker()
    holdDatafile()
    const client = makeClient({ autoInit: false })

    const probe = makeProbe('plan_gate')
    await act(async () => {
      render(wrap(client, createElement(probe.component)))
    })

    const first = probe.seen()[0]
    expect(first.source).toBe('not_ready')
    expect(first.value).toBe(false)
    const before = probe.renders()

    await act(async () => {
      client.applyDatafileBootstrap(datafile())
    })

    expect(probe.renders()).toBeGreaterThan(before)
    const latest = probe.seen()[probe.seen().length - 1]
    expect(latest.value).toBe(true)
    expect(latest.source).toBe('rule')
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })

  it('re-renders on its own flag and stays put when another flag moves', async () => {
    stubTracker()
    const client = makeClient({ plan: 'free' })
    await client.onReady()

    const gate = makeProbe('plan_gate')
    const other = makeProbe('other_flag')
    await act(async () => {
      render(wrap(client, createElement(gate.component)))
      render(wrap(client, createElement(other.component)))
    })

    const gateRenders = gate.renders()
    const otherRenders = other.renders()

    await act(async () => {
      client.identify({ kind: 'user', key: 'u1', plan: 'pro' })
    })

    expect(gate.renders()).toBeGreaterThan(gateRenders)
    expect(gate.seen()[gate.seen().length - 1].value).toBe(true)
    // The flag that did not move must not wake its subscribers.
    expect(other.renders()).toBe(otherRenders)
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })

  it('fires no exposure from rendering', async () => {
    const queue = stubTracker()
    const client = makeClient()
    await client.onReady()

    const probe = makeProbe('plan_gate')
    await act(async () => {
      render(wrap(client, createElement(probe.component)))
    })
    await act(async () => {
      client.identify({ kind: 'user', key: 'u1', plan: 'pro', extra: 1 })
    })

    // Renders are retried, discarded, and replayed by React, so a render
    // must never write exposure data (report 03 §5, handoff item 3).
    expect(queue).not.toHaveBeenCalled()

    await client.close()
  })

  it('stops re-rendering after unmount', async () => {
    stubTracker()
    const client = makeClient({ plan: 'free' })
    await client.onReady()

    const probe = makeProbe('plan_gate')
    let view: ReturnType<typeof render> | null = null
    await act(async () => {
      view = render(wrap(client, createElement(probe.component)))
    })
    const whileMounted = probe.renders()

    view?.unmount()

    await act(async () => {
      client.identify({ kind: 'user', key: 'u1', plan: 'pro' })
    })

    expect(probe.renders()).toBe(whileMounted)

    await client.close()
  })
})

describe('useAllFlags compare-and-swap', () => {
  function makeMapProbe(): { component: () => null; seen: () => Record<string, Flag>[] } {
    const seen: Record<string, Flag>[] = []
    function MapProbe(): null {
      seen.push(useAllFlags())
      return null
    }
    return { component: MapProbe, seen: () => seen }
  }

  it('returns the same object on every render while nothing changes', async () => {
    stubTracker()
    const client = makeClient()
    await client.onReady()

    const probe = makeMapProbe()
    await act(async () => {
      render(wrap(client, createElement(probe.component)))
    })

    const seen = probe.seen()
    expect(seen.length).toBeGreaterThan(0)
    for (const map of seen) expect(map).toBe(seen[0])
    expect(Object.keys(seen[0])).toEqual(['plan_gate', 'other_flag'])
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })

  it('holds one empty object before the datafile lands, not a fresh one per render', async () => {
    stubTracker()
    holdDatafile()
    const client = makeClient({ autoInit: false })

    const probe = makeMapProbe()
    await act(async () => {
      render(wrap(client, createElement(probe.component)))
    })

    const seen = probe.seen()
    // The pre-ready bulk read is a fresh `{}` from the client every call,
    // which is exactly the identity churn React cannot tolerate.
    for (const map of seen) expect(map).toBe(seen[0])
    expect(Object.keys(seen[0])).toHaveLength(0)
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })

  it('swaps to a new object once flags change', async () => {
    stubTracker()
    const client = makeClient({ plan: 'free' })
    await client.onReady()

    const probe = makeMapProbe()
    await act(async () => {
      render(wrap(client, createElement(probe.component)))
    })
    const before = probe.seen()[probe.seen().length - 1]

    await act(async () => {
      client.identify({ kind: 'user', key: 'u1', plan: 'pro' })
    })

    const after = probe.seen()[probe.seen().length - 1]
    expect(after).not.toBe(before)
    expect(after['plan_gate']?.value).toBe(true)

    await client.close()
  })
})

/**
 * `serverFlags` exists to remove hydration flicker, and the promise in
 * `useFlagSuspense`'s docblock is that the server's value "renders immediately".
 * It did not: with a client in the tree the read went straight to the client,
 * which answers `not_ready` until its datafile lands, so a server-rendered value
 * flipped to the caller's default on hydration and flipped back a moment later.
 */
describe('server-evaluated values hold until the client can answer', () => {
  const serverFlags = () =>
    toSerializedFlagMap({
      plan_gate: createFlag<unknown>({
        value: true,
        variationKey: 'on',
        source: 'rule',
        ruleId: 'r_server',
        ruleType: 'ab_test',
        reasons: ['server evaluated'],
      }),
    })

  it('renders the server value while the client is still starting', async () => {
    stubTracker()
    holdDatafile()
    const client = makeClient({ autoInit: false })

    const probe = makeProbe('plan_gate')
    await act(async () => {
      render(wrapWithServerFlags(client, serverFlags(), createElement(probe.component)))
    })

    const first = probe.seen()[0]
    expect(first.value).toBe(true)
    // Not the `not_ready` default, and specifically the SERVER's decision.
    expect(first.source).toBe('rule')
    expect(first.ruleId).toBe('r_server')
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })

  it('hands over to the client once its datafile lands', async () => {
    stubTracker()
    holdDatafile()
    const client = makeClient({ autoInit: false })

    const probe = makeProbe('plan_gate')
    await act(async () => {
      render(wrapWithServerFlags(client, serverFlags(), createElement(probe.component)))
    })
    expect(probe.seen()[0].ruleId).toBe('r_server')

    await act(async () => {
      client.applyDatafileBootstrap(datafile())
    })

    // The client's own evaluation now wins: same value here, but decided by the
    // datafile's rule rather than replayed from the server's blob.
    const latest = probe.seen()[probe.seen().length - 1]
    expect(latest.value).toBe(true)
    expect(latest.ruleId).toBe('r_plan')
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })
})
