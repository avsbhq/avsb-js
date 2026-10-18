/**
 * N1-14 (production QA 2026-10-01): the client a Mode A provider builds
 * reported "@avsbhq/browser" on its heartbeat, so the Environments page could
 * not say a React app was connected. It now reports @avsbhq/react, unless a
 * package wrapping this one (@avsbhq/next, @avsbhq/react-native) passes its
 * own identity. Nothing here asserts markup: the network is stubbed and the
 * heartbeat body is what is measured.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { AvsbProvider } from './AvsbProvider'
import { SDK_VERSION } from './version'

const SDK_KEY = 'sdk_production_reactidentity001'
const HEARTBEAT_URL = 'https://heartbeat.test.invalid/api/sdk/heartbeat'

function stubNetwork(): Array<Record<string, unknown>> {
  const heartbeats: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/datafile.json')) {
        return new Response(
          JSON.stringify({
            version: 2,
            projectType: 'FEATURE_FLAG',
            sdkKey: SDK_KEY,
            environmentKey: 'production',
            publishedAt: '2026-10-01T00:00:00.000Z',
            collectEndpoint: 'https://collect.test.invalid',
            heartbeatEndpoint: HEARTBEAT_URL,
            flags: [],
            audiences: [],
          }),
          { status: 200 }
        )
      }
      if (String(url) === HEARTBEAT_URL) {
        heartbeats.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      }
      return new Response('{}', { status: 200 })
    })
  )
  return heartbeats
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function heartbeatFrom(extraProps: Record<string, unknown>) {
  const heartbeats = stubNetwork()
  await act(async () => {
    render(
      createElement(AvsbProvider, {
        sdkKey: SDK_KEY,
        autoRefresh: false,
        cache: false,
        logLevel: 'silent',
        ...extraProps,
        children: null,
      } as never)
    )
  })
  await vi.waitFor(() => expect(heartbeats).toHaveLength(1))
  return heartbeats[0]
}

describe('AvsbProvider, Mode A: heartbeat identity', () => {
  it('reports @avsbhq/react at its package.json version', async () => {
    expect(await heartbeatFrom({})).toEqual({
      sdkKey: SDK_KEY,
      sdkType: '@avsbhq/react',
      sdkVersion: SDK_VERSION,
    })
  })

  it('reports the wrapping package when one passes its identity', async () => {
    const heartbeat = await heartbeatFrom({
      wrapper: { sdkType: '@avsbhq/react-native', sdkVersion: '1.0.3' },
    })
    expect(heartbeat.sdkType).toBe('@avsbhq/react-native')
    expect(heartbeat.sdkVersion).toBe('1.0.3')
  })
})
