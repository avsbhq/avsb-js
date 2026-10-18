import { afterEach, describe, expect, it, vi } from 'vitest'
import { Injector } from '@angular/core'
import type { Provider } from '@angular/core'
import { AvsbModule, provideAvsb } from './avsb.module'
import { AVSB_CLIENT, AVSB_CONFIG } from './avsb.tokens'
import { AvsbService } from './avsb.service'
import { MockAvsbClient } from './test-support/mockClient'
import { SDK_VERSION } from './version'

/**
 * These tests exercise Mode B (an injected client). Mode A is a factory that
 * constructs a real `AvsbClient`, which starts a datafile fetch; its full path
 * belongs to the end-to-end smoke harness. The one Mode A test at the end of
 * this file stubs the network and checks only the heartbeat identity.
 */
describe('AvsbModule.forRoot', () => {
  it('wires the injected client, the config and the service', () => {
    const client = new MockAvsbClient()
    client.settle({ success: true, source: 'network' })
    const config = { client }

    const providers = (AvsbModule.forRoot(config).providers ?? []) as Provider[]
    const injector = Injector.create({ providers })

    expect(injector.get(AVSB_CONFIG)).toBe(config)
    expect(injector.get(AVSB_CLIENT)).toBe(client)
    expect(injector.get(AvsbService).client).toBe(client)
  })

  it('returns the same module type so it can be imported once', () => {
    const client = new MockAvsbClient()
    const withProviders = AvsbModule.forRoot({ client })

    expect(withProviders.ngModule).toBe(AvsbModule)
  })

  it('never closes a client it was handed', () => {
    const client = new MockAvsbClient()
    client.settle({ success: true, source: 'network' })

    const providers = (AvsbModule.forRoot({ client }).providers ?? []) as Provider[]
    const injector = Injector.create({ providers })
    injector.get(AvsbService).destroy()

    expect(client.closeCount).toBe(0)
  })
})

describe('provideAvsb', () => {
  it('produces environment providers', () => {
    const client = new MockAvsbClient()

    const providers = provideAvsb({ client })

    // EnvironmentProviders is an opaque marker type; the observable property
    // is that it is not a plain array a caller could splice into.
    expect(Array.isArray(providers)).toBe(false)
    expect(providers).toBeDefined()
  })
})

// N1-14: a client built from options (Mode A) names @avsbhq/angular on its
// liveness heartbeat, not @avsbhq/browser. The network is stubbed: the
// datafile is served locally and the heartbeat body is captured.
describe('AvsbModule.forRoot, Mode A heartbeat identity', () => {
  const HEARTBEAT_URL = 'https://heartbeat.test.invalid/api/sdk/heartbeat'
  const SDK_KEY = 'sdk_production_angularidentity1'

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports @avsbhq/angular at its package.json version', async () => {
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

    const providers = (AvsbModule.forRoot({
      sdkKey: SDK_KEY,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent',
    }).providers ?? []) as Provider[]
    const client = Injector.create({ providers }).get(AVSB_CLIENT)

    await client.onReady()
    await vi.waitFor(() => expect(heartbeats).toHaveLength(1))
    expect(heartbeats[0]).toEqual({
      sdkKey: SDK_KEY,
      sdkType: '@avsbhq/angular',
      sdkVersion: SDK_VERSION,
    })
    await client.close()
  })
})
