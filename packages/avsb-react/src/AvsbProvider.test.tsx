/**
 * Provider lifecycle and status wiring.
 *
 * The client is a controllable stand-in here ON PURPOSE: what is under
 * test is ownership and the status machine (how many clients get built,
 * which get closed, what an 'error' event means), not evaluation. Reads,
 * snapshot identity, and exposures are tested against the REAL client in
 * useFlag.test.tsx and typedHooks.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement, StrictMode, type ReactElement, type ReactNode } from 'react'
import type { InitResult } from '@avsbhq/core'
import { AvsbProvider } from './AvsbProvider'
import { useAvsbClient } from './useAvsbClient'
import { useAvsbStatus } from './useAvsbStatus'
import type { AvsbStatusState } from './providerStatus'
import type { ReactAvsbClient } from './clientInterface'

// ---------------------------------------------------------------------------
// A client whose readiness and events the test drives.
// ---------------------------------------------------------------------------

interface FakeClient extends ReactAvsbClient {
  _closes: number
  _emitError: (error: Error) => void
  _emitReady: () => void
  _emitConfigUpdate: () => void
  _become: (result: InitResult, readable: boolean) => void
}

function makeFakeClient(options?: { readable?: boolean; result?: InitResult }): FakeClient {
  let readable = options?.readable ?? true
  let result: InitResult | null = options?.result ?? { success: true, source: 'bootstrap' }
  const listeners = new Map<string, Set<(payload: never) => void>>()
  let resolveReady: (value: InitResult) => void = () => undefined
  const readyPromise = new Promise<InitResult>((resolve) => {
    resolveReady = resolve
  })
  if (result) resolveReady(result)

  const emit = (event: string, payload: unknown): void => {
    for (const listener of listeners.get(event) ?? []) {
      ;(listener as (value: unknown) => void)(payload)
    }
  }

  const client = {
    _closes: 0,
    isReady: () => readable,
    getInitResult: () => result,
    onReady: () => readyPromise,
    close: () => {
      client._closes += 1
      return Promise.resolve()
    },
    flush: () => Promise.resolve(),
    identify: vi.fn(),
    updateAttributes: vi.fn(),
    alias: () => Promise.resolve(),
    getContext: () => ({ kind: 'user', key: 'u1' }),
    reset: vi.fn(),
    getFlag: vi.fn(),
    getBoolFlag: vi.fn(),
    getStringFlag: vi.fn(),
    getNumberFlag: vi.fn(),
    getJsonFlag: vi.fn(),
    getAllFlags: () => ({}),
    subscribe: () => () => undefined,
    getSnapshot: vi.fn(),
    track: vi.fn(),
    on: (event: string, cb: (payload: never) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => {
        set.delete(cb)
      }
    },
    setOverrideForUser: vi.fn(),
    setGlobalOverride: vi.fn(),
    clearOverrideForUser: vi.fn(),
    clearGlobalOverride: vi.fn(),
    clearAllOverrides: vi.fn(),
    _emitError: (error: Error) => emit('error', error),
    _emitReady: () => emit('ready', result),
    _emitConfigUpdate: () => emit('configUpdate', { publishedAt: 'x', reason: 'poll' }),
    _become: (next: InitResult, nextReadable: boolean) => {
      result = next
      readable = nextReadable
      resolveReady(next)
    },
  } as unknown as FakeClient

  return client
}

// Mode A builds its client through this constructor.
const built: FakeClient[] = []
vi.mock('@avsbhq/browser', () => ({
  AvsbClient: function AvsbClientMock(this: unknown) {
    const instance = makeFakeClient()
    built.push(instance)
    return instance
  },
}))

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

function statusProbe(): { component: () => null; latest: () => AvsbStatusState | null } {
  let latest: AvsbStatusState | null = null
  function StatusProbe(): null {
    latest = useAvsbStatus()
    return null
  }
  return { component: StatusProbe, latest: () => latest }
}

function clientProbe(): { component: () => null; latest: () => ReactAvsbClient | null } {
  let latest: ReactAvsbClient | null = null
  function ClientProbe(): null {
    latest = useAvsbClient()
    return null
  }
  return { component: ClientProbe, latest: () => latest }
}

function modeA(children: ReactNode, strict = false): ReactElement {
  const tree = createElement(AvsbProvider, {
    sdkKey: 'sdk_production_provider00000',
    context: { kind: 'user', key: 'u1' },
    children,
  })
  return strict ? createElement(StrictMode, null, tree) : tree
}

beforeEach(() => {
  built.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AvsbProvider Mode A ownership', () => {
  it('builds the client in an effect and hands out a live one under StrictMode', async () => {
    const probe = clientProbe()

    await act(async () => {
      render(modeA(createElement(probe.component), true))
    })

    // StrictMode runs setup, cleanup, setup. The old provider created the
    // client during render, closed it in the first cleanup, and left the
    // tree on that closed instance with no re-render to replace it.
    const live = probe.latest()
    expect(live).not.toBeNull()
    const closedCount = built.filter((client) => client._closes > 0).length
    expect(built.length).toBeGreaterThanOrEqual(1)
    expect((live as FakeClient)._closes).toBe(0)
    // Every client that is not the live one was closed.
    expect(closedCount).toBe(built.length - 1)
  })

  it('closes the owned client exactly once on unmount', async () => {
    let view: ReturnType<typeof render> | null = null
    await act(async () => {
      view = render(modeA(null))
    })
    const client = built[built.length - 1]
    expect(client._closes).toBe(0)

    view?.unmount()

    expect(client._closes).toBe(1)
  })

  it('reports an actionable error instead of building a keyless client', async () => {
    const probe = statusProbe()

    await act(async () => {
      render(
        createElement(AvsbProvider, {
          sdkKey: '',
          children: createElement(probe.component),
        }),
      )
    })

    expect(built).toHaveLength(0)
    expect(probe.latest()?.status).toBe('error')
    expect(probe.latest()?.error?.message).toMatch(/sdkKey/)
    expect(probe.latest()?.error?.message).toMatch(/Environments in the project sidebar/)
  })
})

describe('AvsbProvider Mode B ownership', () => {
  it('never closes an injected client', async () => {
    const client = makeFakeClient()
    let view: ReturnType<typeof render> | null = null

    await act(async () => {
      view = render(createElement(AvsbProvider, { client, children: null }))
    })
    view?.unmount()

    expect(client._closes).toBe(0)
  })

  it('adopts an already-ready client without a loading flash', async () => {
    const client = makeFakeClient({ readable: true })
    const probe = statusProbe()

    await act(async () => {
      render(createElement(AvsbProvider, { client, children: createElement(probe.component) }))
    })

    expect(probe.latest()).toEqual({ status: 'ready', degraded: false, error: undefined })
  })
})

describe('AvsbProvider status', () => {
  it('treats a degraded error event as ready-with-warning, never fatal', async () => {
    // The exact shape the browser client produces when a cached datafile is
    // served after a failed refresh: an 'error' EVENT plus a successful,
    // degraded init result.
    const client = makeFakeClient({ readable: true })
    const probe = statusProbe()

    await act(async () => {
      render(createElement(AvsbProvider, { client, children: createElement(probe.component) }))
    })

    const refreshFailure = new Error('datafile refresh failed (503) for https://cdn.avsb.cloud/x')
    await act(async () => {
      client._emitError(refreshFailure)
    })

    expect(probe.latest()?.status).toBe('ready')
    expect(probe.latest()?.degraded).toBe(true)
    expect(probe.latest()?.error).toBe(refreshFailure)
  })

  it('clears the warning when a later refresh succeeds', async () => {
    const client = makeFakeClient({ readable: true })
    const probe = statusProbe()

    await act(async () => {
      render(createElement(AvsbProvider, { client, children: createElement(probe.component) }))
    })
    await act(async () => {
      client._emitError(new Error('transient'))
    })
    expect(probe.latest()?.degraded).toBe(true)

    await act(async () => {
      client._emitConfigUpdate()
    })

    expect(probe.latest()?.degraded).toBe(false)
    expect(probe.latest()?.error).toBeUndefined()
  })

  it('reports error when init settled with nothing to serve', async () => {
    const failure = new Error('datafile 404 for https://cdn.avsb.cloud/sdk_x/datafile.json')
    const client = makeFakeClient({
      readable: false,
      result: { success: false, source: 'error', error: failure },
    })
    const probe = statusProbe()

    await act(async () => {
      render(createElement(AvsbProvider, { client, children: createElement(probe.component) }))
    })

    expect(probe.latest()?.status).toBe('error')
    expect(probe.latest()?.error).toBe(failure)
  })

  it('recovers to ready when a later poll rescues a failed init', async () => {
    const client = makeFakeClient({
      readable: false,
      result: { success: false, source: 'error', error: new Error('boom') },
    })
    const probe = statusProbe()

    await act(async () => {
      render(createElement(AvsbProvider, { client, children: createElement(probe.component) }))
    })
    expect(probe.latest()?.status).toBe('error')

    await act(async () => {
      client._become({ success: true, source: 'network' }, true)
      client._emitReady()
    })

    expect(probe.latest()?.status).toBe('ready')
    expect(probe.latest()?.degraded).toBe(false)
  })
})

describe('AvsbProvider context prop', () => {
  function modeATree(plan: string): ReactElement {
    // A fresh object literal every render, which is what an app writes.
    return createElement(AvsbProvider, {
      sdkKey: 'sdk_production_provider00000',
      context: { kind: 'user', key: 'u1', plan },
      children: null,
    })
  }

  it('identifies when the context VALUE changes, and not when only its identity does', async () => {
    let view: ReturnType<typeof render> | null = null
    await act(async () => {
      view = render(modeATree('free'))
    })
    const client = built[built.length - 1]
    const identify = client.identify as ReturnType<typeof vi.fn>

    // Same values, new object: the client was constructed with them, so
    // re-identifying would be pure churn.
    await act(async () => {
      view?.rerender(modeATree('free'))
    })
    expect(identify).not.toHaveBeenCalled()

    await act(async () => {
      view?.rerender(modeATree('pro'))
    })
    expect(identify).toHaveBeenCalledTimes(1)
    expect(identify).toHaveBeenCalledWith({ kind: 'user', key: 'u1', plan: 'pro' })
  })

  it('does not rebuild the client when only the context changes', async () => {
    let view: ReturnType<typeof render> | null = null
    await act(async () => {
      view = render(modeATree('free'))
    })
    const builtAfterMount = built.length

    await act(async () => {
      view?.rerender(modeATree('pro'))
    })

    expect(built.length).toBe(builtAfterMount)
  })
})
