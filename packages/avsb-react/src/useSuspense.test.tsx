/**
 * Suspense, against the real client.
 *
 * What is asserted is whether the component body ran, not what it
 * rendered: a suspended component never runs, so the counters below are
 * the honest signal.
 *
 * The gate is the PROVIDER's status leaving 'loading', not
 * `client.onReady()`. Throwing an already-resolved promise makes React
 * retry immediately, and if the status had not been committed yet the old
 * hook could spin; a promise tied to the state React re-renders with
 * cannot.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  Component,
  createElement,
  Suspense,
  type ErrorInfo,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { FlagDatafile } from '@avsbhq/core'
import { AvsbClient } from '../../avsb-browser/src/AvsbClient'
import type { Tracker } from '../../avsb-browser/src/types'
import * as trackerModule from '../../avsb-browser/src/tracker'
import { AvsbProvider } from './AvsbProvider'
import { useFlagSuspense } from './useFlagSuspense'
import { useAvsbClientSuspense } from './useAvsbClientSuspense'
import { toSerializedFlagMap } from './serverFlags'
import { createFlag } from '@avsbhq/core'

const SDK_KEY = 'sdk_production_suspense000000'

function datafile(): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
    publishedAt: '2026-01-01T00:00:00Z',
    collectEndpoint: 'https://collect.test.invalid',
    audiences: [],
    flags: [
      {
        id: 'f1',
        key: 'checkout_v2',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'v_on',
        variations: [{ id: 'v_on', key: 'on', value: true }],
        overrides: [],
        rules: [],
      },
    ],
  }
}

function stubTracker(): void {
  const tracker: Tracker = {
    queue: vi.fn(),
    queueMetric: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  }
  vi.spyOn(trackerModule, 'createTracker').mockReturnValue(tracker)
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

function pendingClient(): AvsbClient {
  return new AvsbClient({
    sdkKey: SDK_KEY,
    context: { kind: 'user', key: 'u1' },
    autoInit: false,
    autoRefresh: false,
    cache: false,
    logLevel: 'silent',
  })
}

function tree(client: AvsbClient, children: ReactNode, serverFlags?: unknown): ReactElement {
  return createElement(
    AvsbProvider,
    {
      client,
      ...(serverFlags ? { serverFlags } : {}),
      children: createElement(Suspense, { fallback: null }, children),
    } as never,
  )
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
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

describe('useFlagSuspense', () => {
  it('does not run the component while flags are unreadable, then runs it with a real value', async () => {
    stubTracker()
    holdDatafile()
    const client = pendingClient()
    const values: boolean[] = []

    function Probe(): null {
      values.push(useFlagSuspense('checkout_v2', false).value)
      return null
    }

    await act(async () => {
      render(tree(client, createElement(Probe)))
    })
    expect(values).toHaveLength(0)

    await act(async () => {
      client.applyDatafileBootstrap(datafile())
    })

    expect(values.length).toBeGreaterThan(0)
    expect(values[values.length - 1]).toBe(true)

    await client.close()
  })

  it('does not suspend when the server already answered', async () => {
    stubTracker()
    holdDatafile()
    const client = pendingClient()
    const values: boolean[] = []

    function Probe(): null {
      values.push(useFlagSuspense('checkout_v2', false).value)
      return null
    }

    const serverFlags = toSerializedFlagMap({
      checkout_v2: createFlag<unknown>({
        value: true,
        variationKey: 'on',
        source: 'rule',
        ruleId: 'r1',
        ruleType: 'ab_test',
        reasons: ['server evaluated'],
      }),
    })

    await act(async () => {
      render(tree(client, createElement(Probe), serverFlags))
    })

    // A server-rendered page must not blank out into a fallback just
    // because the browser client has not finished starting.
    expect(values).toHaveLength(1)
    expect(values[0]).toBe(true)

    // And the client takes over once it can answer.
    await act(async () => {
      client.applyDatafileBootstrap(datafile())
    })
    expect(values[values.length - 1]).toBe(true)

    await client.close()
  })

  it('gives up suspending when init fails, instead of holding the fallback forever', async () => {
    stubTracker()
    const held = holdDatafile()
    const client = pendingClient()
    let ran = 0

    // Counted AFTER the hook, so it only moves when the component actually
    // got through it: React re-runs the body of a suspended component every
    // time it retries, so a counter above the hook would tick while the
    // boundary is still holding its fallback.
    function Probe(): null {
      useFlagSuspense('checkout_v2', false)
      ran += 1
      return null
    }

    await act(async () => {
      render(tree(client, createElement(Probe)))
    })
    expect(ran).toBe(0)

    // A failed init settles the status, which resolves the gate.
    await act(async () => {
      held.fail(new Error('offline'))
      await client.onReady()
    })

    expect(ran).toBeGreaterThan(0)

    await client.close()
  })
})

/**
 * Catches what a component throws, so a test can assert on it instead of
 * letting React tear the tree down.
 */
interface BoundaryProps {
  onError: (error: Error) => void
  children: ReactNode
}

class Boundary extends Component<BoundaryProps, { failed: boolean }> {
  state: { failed: boolean } = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError(error)
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

describe('useAvsbClientSuspense', () => {
  it('waits for the status to settle, then returns the client', async () => {
    stubTracker()
    holdDatafile()
    const client = pendingClient()
    const seen: unknown[] = []

    function Probe(): null {
      seen.push(useAvsbClientSuspense())
      return null
    }

    await act(async () => {
      render(tree(client, createElement(Probe)))
    })
    expect(seen).toHaveLength(0)

    await act(async () => {
      client.applyDatafileBootstrap(datafile())
    })

    expect(seen[0]).toBe(client)

    await client.close()
  })

  it('raises the missing-key error instead of suspending forever', async () => {
    // The livelock this guards: with no sdkKey the provider settles to
    // 'error' with no client, so a "no client yet" guard would throw an
    // already-resolved promise, React would retry, and the boundary would
    // hold its fallback for ever. The status guard has to come first.
    let caught: Error | null = null
    let ran = 0

    function Probe(): null {
      ran += 1
      useAvsbClientSuspense()
      return null
    }

    await act(async () => {
      render(
        createElement(AvsbProvider, {
          sdkKey: '',
          children: createElement(
            Boundary,
            {
              onError: (error: Error) => {
                caught = error
              },
            },
            createElement(Suspense, { fallback: null }, createElement(Probe)),
          ),
        }),
      )
    })

    expect(ran).toBeGreaterThan(0)
    expect(caught).toBeInstanceOf(Error)
    expect((caught as unknown as Error).message).toMatch(/there is no client/)
    expect((caught as unknown as Error).message).toMatch(/Environments in the project sidebar/)
  })
})
