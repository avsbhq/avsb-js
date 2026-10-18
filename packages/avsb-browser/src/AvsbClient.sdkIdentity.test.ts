// N1-14 (production QA 2026-10-01): every framework package's heartbeat
// said "@avsbhq/browser 1.4.1", so the Environments page could not show which
// package was connected, and the version lagged the package. The client now
// reports its generated identity, or the `wrapper` a framework package passes.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlagDatafile } from '@avsbhq/core'
import { AvsbClient } from './AvsbClient'
import { SDK_TYPE, SDK_VERSION } from './version'

const SDK_KEY = 'sdk_production_identitytest0001'
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
    flags: [],
    audiences: [],
  }
}

/** Serve the datafile, and record every heartbeat body. */
function stubNetwork(): () => Array<Record<string, unknown>> {
  const heartbeats: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url)
      if (target.includes('/datafile.json')) {
        return new Response(JSON.stringify(datafile()), { status: 200 })
      }
      if (target === HEARTBEAT_URL) {
        heartbeats.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      }
      return new Response('{}', { status: 200 })
    })
  )
  return () => heartbeats
}

const clients: AvsbClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  vi.unstubAllGlobals()
})

async function heartbeatFrom(options: { wrapper?: { sdkType: string; sdkVersion: string } }) {
  const heartbeats = stubNetwork()
  const client = new AvsbClient({
    sdkKey: SDK_KEY,
    context: { kind: 'user', key: 'u1' },
    autoRefresh: false,
    cache: false,
    logLevel: 'silent',
    ...options,
  })
  clients.push(client)
  await client.onReady()
  await vi.waitFor(() => expect(heartbeats()).toHaveLength(1))
  return heartbeats()[0]
}

describe('the heartbeat names the SDK that sent it', () => {
  it('reports @avsbhq/browser at its package.json version by default', async () => {
    expect(await heartbeatFrom({})).toEqual({
      sdkKey: SDK_KEY,
      sdkType: SDK_TYPE,
      sdkVersion: SDK_VERSION,
    })
    expect(SDK_TYPE).toBe('@avsbhq/browser')
  })

  it('reports the wrapping framework package when one is passed', async () => {
    expect(
      await heartbeatFrom({ wrapper: { sdkType: '@avsbhq/react', sdkVersion: '9.9.9' } })
    ).toEqual({ sdkKey: SDK_KEY, sdkType: '@avsbhq/react', sdkVersion: '9.9.9' })
  })

  it('sends nothing when the datafile publishes no heartbeat endpoint', async () => {
    const heartbeats = stubNetwork()
    const withoutEndpoint = { ...datafile(), heartbeatEndpoint: undefined }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(withoutEndpoint), { status: 200 }))
    )
    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent',
      wrapper: { sdkType: '@avsbhq/vue', sdkVersion: '1.0.0' },
    })
    clients.push(client)
    await client.onReady()
    expect(heartbeats()).toEqual([])
  })
})
