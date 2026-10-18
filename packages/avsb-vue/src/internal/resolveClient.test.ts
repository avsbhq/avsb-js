// N1-14 (production QA 2026-10-01): a client built by @avsbhq/vue reported
// "@avsbhq/browser" on its heartbeat, so the Environments page could not say
// which package was connected. It now reports @avsbhq/vue at its own
// package.json version.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AvsbProviderProps } from '../types'
import { SDK_TYPE, SDK_VERSION } from '../version'
import { resolveClient } from './resolveClient'

const SDK_KEY = 'sdk_production_vueidentity000001'

const HEARTBEAT_URL = 'https://heartbeat.test.invalid/api/sdk/heartbeat'

/** Serve a datafile that asks for heartbeats, and record each heartbeat body. */
function stubNetwork(sdkKey: string): () => Array<Record<string, unknown>> {
  const heartbeats: Array<Record<string, unknown>> = []
  const datafile = {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey,
    environmentKey: 'production',
    publishedAt: '2026-10-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.test.invalid',
    heartbeatEndpoint: HEARTBEAT_URL,
    flags: [],
    audiences: [],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes('/datafile.json')) {
        return new Response(JSON.stringify(datafile), { status: 200 })
      }
      if (String(url) === HEARTBEAT_URL) {
        heartbeats.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      }
      return new Response('{}', { status: 200 })
    })
  )
  return () => heartbeats
}

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
  vi.unstubAllGlobals()
})

async function heartbeatOf(props: Record<string, unknown>): Promise<Record<string, unknown>> {
  const heartbeats = stubNetwork(SDK_KEY)
  const { client } = resolveClient({
    sdkKey: SDK_KEY,
    options: { autoRefresh: false, cache: false, logLevel: 'silent', ...props },
  } as AvsbProviderProps)
  closers.push(() => client.close())
  await client.onReady()
  await vi.waitFor(() => expect(heartbeats()).toHaveLength(1))
  return heartbeats()[0]
}

describe('the vue client names itself on the heartbeat', () => {
  it('reports @avsbhq/vue at its package.json version', async () => {
    expect(await heartbeatOf({})).toEqual({
      sdkKey: SDK_KEY,
      sdkType: '@avsbhq/vue',
      sdkVersion: SDK_VERSION,
    })
    expect(SDK_TYPE).toBe('@avsbhq/vue')
  })

  it('keeps the identity @avsbhq/nuxt passes through the plugin options', async () => {
    const heartbeat = await heartbeatOf({ wrapper: { sdkType: '@avsbhq/nuxt', sdkVersion: '2.0.0' } })
    expect(heartbeat.sdkType).toBe('@avsbhq/nuxt')
    expect(heartbeat.sdkVersion).toBe('2.0.0')
  })

  it('does not build a client for an injected one, so nothing is relabelled', () => {
    const injected = { close: async () => undefined }
    const resolved = resolveClient({ client: injected } as unknown as AvsbProviderProps)
    expect(resolved.client).toBe(injected)
    expect(resolved.owned).toBe(false)
  })
})
