// @vitest-environment happy-dom
/**
 * N1-5 (production QA 2026-10-01): the published React Native provider
 * looped its flag hooks on mount (old pinned dependencies), dropped every
 * option except sdkKey and context, never closed its client on unmount, and
 * reported "@avsbhq/browser" on its heartbeat. These drive the provider with
 * the real browser client and the real React provider underneath. Nothing
 * here asserts markup: probes render null and record what the hooks read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { StrictMode, createElement, type ReactNode } from 'react'
import type { Flag, FlagDatafile } from '@avsbhq/core'
import { AvsbClient } from '@avsbhq/browser'
import { useAvsbClient, useBoolFlag } from '@avsbhq/react'
import { AvsbProvider } from './AvsbProvider'
import { SDK_VERSION } from './version'

const SDK_KEY = 'sdk_production_reactnativelife1'
const HEARTBEAT_URL = 'https://heartbeat.test.invalid/api/sdk/heartbeat'

function datafile(): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
    publishedAt: '2026-10-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.test.invalid',
    heartbeatEndpoint: HEARTBEAT_URL,
    flags: [
      {
        id: 'flag_1',
        key: 'checkout_v2',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'var_on',
        variations: [{ id: 'var_on', key: 'on', value: true }],
        overrides: [],
        rules: [],
      },
    ],
    audiences: [],
  }
}

/** Serve the datafile; record heartbeat bodies. */
function stubNetwork(): Array<Record<string, unknown>> {
  const heartbeats: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/datafile.json')) {
        return new Response(JSON.stringify(datafile()), { status: 200 })
      }
      if (String(url) === HEARTBEAT_URL) {
        heartbeats.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      }
      return new Response('{}', { status: 200 })
    })
  )
  return heartbeats
}

function provider(children: ReactNode, props: Record<string, unknown> = {}) {
  return createElement(AvsbProvider, {
    sdkKey: SDK_KEY,
    autoRefresh: false,
    cache: false,
    logLevel: 'silent',
    ...props,
    children,
  } as never)
}

let consoleError: ReturnType<typeof vi.spyOn>

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('React Native AvsbProvider (N1-5)', () => {
  it('reads a flag on mount without looping, from an option it passes through', async () => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    stubNetwork()
    let renders = 0
    let seen: Flag<boolean> | null = null
    function Probe(): null {
      renders += 1
      seen = useBoolFlag('checkout_v2', false)
      return null
    }

    await act(async () => {
      render(provider(createElement(Probe), { bootstrap: datafile() }))
    })

    // `bootstrap` is not one of the two props the published build forwarded.
    expect(seen).not.toBeNull()
    expect((seen as unknown as Flag<boolean>).value).toBe(true)
    // "Maximum update depth exceeded" is a render storm; a handful is normal.
    expect(renders).toBeLessThan(10)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('closes the client it built when the tree unmounts', async () => {
    stubNetwork()
    const close = vi.spyOn(AvsbClient.prototype, 'close')
    let client: unknown = null
    function Probe(): null {
      client = useAvsbClient()
      return null
    }

    const view = render(provider(createElement(Probe)))
    await act(async () => undefined)
    expect(client).toBeInstanceOf(AvsbClient)

    view.unmount()
    expect(close).toHaveBeenCalled()
  })

  it('leaves no live client behind under StrictMode double mounting', async () => {
    stubNetwork()
    const created: AvsbClient[] = []
    const close = vi.spyOn(AvsbClient.prototype, 'close')
    function Probe(): null {
      const client = useAvsbClient()
      if (client instanceof AvsbClient && !created.includes(client)) created.push(client)
      return null
    }

    const view = render(createElement(StrictMode, null, provider(createElement(Probe))))
    await act(async () => undefined)
    view.unmount()

    // Every client the provider built was closed again.
    expect(close.mock.calls.length).toBeGreaterThanOrEqual(created.length)
  })

  it('names @avsbhq/react-native at its own version on the heartbeat', async () => {
    const heartbeats = stubNetwork()

    await act(async () => {
      render(provider(null))
    })
    await vi.waitFor(() => expect(heartbeats).toHaveLength(1))

    expect(heartbeats[0]).toEqual({
      sdkKey: SDK_KEY,
      sdkType: '@avsbhq/react-native',
      sdkVersion: SDK_VERSION,
    })
  })
})
