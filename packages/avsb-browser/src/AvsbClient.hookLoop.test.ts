/**
 * The store contract, driven by React's real `useSyncExternalStore` against
 * the REAL AvsbClient (spec §4 item 6).
 *
 * This is not a UI test and asserts nothing about markup: the probe
 * component renders `null`. What it measures is the store contract that the
 * seven framework adapters depend on and that a hand-written mock client
 * hid for a whole release: snapshot identity, render counts, wake-up on the
 * ready transition, and no exposure side effects from render.
 *
 * Why React and not a hand-rolled loop: the failure mode is React's own.
 * A `getSnapshot` that returns a fresh object per call makes React 19 bail
 * with "The result of getSnapshot should be cached to avoid an infinite
 * loop", and only React can produce that. `createElement` is used instead
 * of JSX so this file stays plain TypeScript, which the package's tsconfig
 * compiles without a JSX setting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, useSyncExternalStore } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { AvsbClient } from './AvsbClient'
import type { Flag, FlagDatafile, Tracker } from './types'
import * as trackerModule from './tracker'

const SDK_KEY = 'sdk_production_hookloop00000000000'

function datafile(): FlagDatafile {
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
  }
}

function trackerSpy(): ReturnType<typeof vi.fn> {
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

interface Probe {
  component: () => null
  renders: () => number
  snapshots: () => Flag<boolean>[]
}

/**
 * The same shape every framework adapter uses: subscribe to one flag, read
 * a render-safe snapshot, render from it.
 */
function makeProbe(client: AvsbClient, flagKey: string): Probe {
  let renderCount = 0
  const seen: Flag<boolean>[] = []

  function ProbeComponent(): null {
    renderCount += 1
    const flag = useSyncExternalStore(
      (onStoreChange) => client.subscribe(flagKey, onStoreChange),
      () => client.getBoolFlag(flagKey, false, { readOnly: true }),
      () => client.getBoolFlag(flagKey, false, { readOnly: true }),
    )
    seen.push(flag)
    return null
  }

  return {
    component: ProbeComponent,
    renders: () => renderCount,
    snapshots: () => seen,
  }
}

function mockFetchOnce(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve(body),
      }),
    ),
  )
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  // React reports the getSnapshot caching violation through console.error,
  // so every test in this file also asserts that it stayed quiet.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useSyncExternalStore against the real client', () => {
  it('renders a bounded number of times and sees one stable snapshot', async () => {
    trackerSpy()
    mockFetchOnce(datafile())
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    await client.onReady()

    const probe = makeProbe(client, 'plan_gate')
    render(createElement(probe.component))

    // The pre-fix client returned a fresh frozen Flag per call, which React
    // treats as a changed store on every render.
    expect(probe.renders()).toBeLessThanOrEqual(2)
    const snapshots = probe.snapshots()
    expect(snapshots.length).toBeGreaterThan(0)
    for (const snapshot of snapshots) expect(snapshot).toBe(snapshots[0])
    expect(snapshots[0].value).toBe(true)
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })

  it('wakes a component that mounted before the datafile arrived', async () => {
    trackerSpy()
    mockFetchOnce(datafile())
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoInit: false,
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })

    const probe = makeProbe(client, 'plan_gate')
    render(createElement(probe.component))

    const first = probe.snapshots()[0]
    expect(first.source).toBe('not_ready')
    expect(first.value).toBe(false)
    const rendersBefore = probe.renders()

    await act(async () => {
      await client.onReady()
    })

    // The ready transition has to notify subscribers or the hook renders
    // defaults forever: this is the bug that made every adapter look broken.
    expect(probe.renders()).toBeGreaterThan(rendersBefore)
    const latest = probe.snapshots()[probe.snapshots().length - 1]
    expect(latest.value).toBe(true)
    expect(latest.source).toBe('rule')
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })

  it('re-renders on a change to its own flag and not on a change to another', async () => {
    trackerSpy()
    mockFetchOnce(datafile())
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'free' },
    })
    await client.onReady()

    const gate = makeProbe(client, 'plan_gate')
    const always = makeProbe(client, 'always_on')
    render(createElement(gate.component))
    render(createElement(always.component))

    const gateRenders = gate.renders()
    const alwaysRenders = always.renders()

    await act(async () => {
      client.identify({ kind: 'user', key: 'u1', plan: 'pro' })
    })

    expect(gate.renders()).toBeGreaterThan(gateRenders)
    const gateSnapshots = gate.snapshots()
    expect(gateSnapshots[gateSnapshots.length - 1].value).toBe(true)
    // The flag that did not move must not re-render its subscribers.
    expect(always.renders()).toBe(alwaysRenders)
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })

  it('stays stable across an override change that does not affect it', async () => {
    trackerSpy()
    mockFetchOnce(datafile())
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    await client.onReady()

    const probe = makeProbe(client, 'plan_gate')
    render(createElement(probe.component))
    const before = probe.snapshots()[probe.snapshots().length - 1]

    await act(async () => {
      client.setGlobalOverride('always_on', 'off')
    })

    expect(probe.snapshots()[probe.snapshots().length - 1]).toBe(before)
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })

  it('fires no exposure while rendering, and one when the app decides', async () => {
    const queue = trackerSpy()
    mockFetchOnce(datafile())
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'pro' },
    })
    await client.onReady()

    const probe = makeProbe(client, 'plan_gate')
    render(createElement(probe.component))

    await act(async () => {
      client.identify({ kind: 'user', key: 'u1', plan: 'pro', extra: 1 })
    })

    // Renders are retried, discarded, and replayed by React, so exposure
    // data must never be written from one (report 03 handoff item 3).
    expect(queue).not.toHaveBeenCalled()

    client.getBoolFlag('plan_gate', false)
    expect(queue).toHaveBeenCalledTimes(1)

    await client.close()
  })

  it('stops re-rendering after unmount', async () => {
    trackerSpy()
    mockFetchOnce(datafile())
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: datafile(),
      autoRefresh: false,
      context: { kind: 'user', key: 'u1', plan: 'free' },
    })
    await client.onReady()

    const probe = makeProbe(client, 'plan_gate')
    const view = render(createElement(probe.component))
    const rendersWhileMounted = probe.renders()

    view.unmount()

    await act(async () => {
      client.identify({ kind: 'user', key: 'u1', plan: 'pro' })
    })

    expect(probe.renders()).toBe(rendersWhileMounted)
    expect(consoleError).not.toHaveBeenCalled()

    await client.close()
  })
})
