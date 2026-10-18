import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AvsbServer } from './AvsbServer'
import type { FlagDatafile } from '@avsbhq/core'

const datafile: FlagDatafile = {
  version: 2,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk',
  environmentKey: 'prod',
  publishedAt: '2026-05-28T00:00:00Z',
  collectEndpoint: 'https://collect.test',
  flags: [],
  audiences: [],
}

describe('AvsbServer.utils', () => {
  let server: AvsbServer

  beforeEach(() => {
    server = new AvsbServer({
      sdkKey: 'sdk',
      bootstrap: datafile,
    })
  })

  afterEach(async () => {
    await server.close()
  })

  it('exposes the AvsbUtils surface lazily', () => {
    expect(typeof server.utils.once).toBe('function')
    expect(typeof server.utils.debounce).toBe('function')
    expect(typeof server.utils.context.defineSchema).toBe('function')
    expect(typeof server.utils.createDecisionRecorder).toBe('function')
  })

  it('returns the same instance on repeated access (lazy memo)', () => {
    expect(server.utils).toBe(server.utils)
  })

  it('debounce + once helpers are wired and functional', () => {
    const fn = vi.fn(() => 'x')
    const onced = server.utils.once(fn)
    onced()
    onced()
    expect(fn).toHaveBeenCalledOnce()
  })

  it('registerCleanup teardowns drain on close()', async () => {
    const teardown = vi.fn()
    server.utils.registerCleanup(teardown)
    await server.close()
    expect(teardown).toHaveBeenCalledOnce()
  })

  it('storage adapter defaults to in-memory', () => {
    expect(server.utils.storage.isHealthy()).toBe(true)
  })
})

// FU-39: the server adapter had no `refresh`, so `snapshotFresh` and
// `refreshAndSnapshot` skipped the fetch and snapshotted whatever datafile was
// already in memory. These tests serve two different datafiles from the CDN
// stub and prove the second snapshot sees the second one.
describe('AvsbServer.utils fresh snapshots', () => {
  const KEY = 'sdk_production_nodetest0000001'
  const ctx = { kind: 'user', key: 'user-1', userId: 'user-1' }

  function flagDatafile(publishedAt: string, value: boolean): FlagDatafile {
    return {
      ...datafile,
      publishedAt,
      flags: [
        {
          id: 'flag-1',
          key: 'checkout',
          type: 'boolean',
          enabled: true,
          defaultVariationId: value ? 'var-on' : 'var-off',
          variations: [
            { id: 'var-off', key: 'off', value: false },
            { id: 'var-on', key: 'on', value: true },
          ],
          overrides: [],
          rules: [],
        },
      ],
    }
  }

  function serveDatafiles(sequence: FlagDatafile[]): { datafileCalls: () => number } {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = String(input)
        if (url.includes('/collect')) {
          return Promise.resolve(new Response('{}', { status: 200 }))
        }
        const df = sequence[Math.min(calls, sequence.length - 1)]
        calls++
        return Promise.resolve(
          new Response(JSON.stringify(df), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
      })
    )
    return { datafileCalls: () => calls }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('snapshotFresh fetches once and reflects a datafile that changed between calls', async () => {
    const served = serveDatafiles([
      flagDatafile('2026-10-01T00:00:00Z', false),
      flagDatafile('2026-10-02T00:00:00Z', true),
    ])
    const server = new AvsbServer({
      sdkKey: KEY,
      streaming: false,
      pollingInterval: 300_000,
    })
    await server.onReady()
    expect(served.datafileCalls()).toBe(1)

    const before = server.utils.snapshot(ctx)
    expect(before.flags.checkout?.value).toBe(false)

    const fresh = await server.utils.snapshotFresh(ctx)
    expect(served.datafileCalls()).toBe(2)
    expect(fresh.datafileVersion).toBe('2026-10-02T00:00:00Z')
    expect(fresh.flags.checkout?.value).toBe(true)
    await server.close()
  })

  it('refreshAndSnapshot goes through the same refresh', async () => {
    const served = serveDatafiles([
      flagDatafile('2026-10-01T00:00:00Z', false),
      flagDatafile('2026-10-02T00:00:00Z', true),
    ])
    const server = new AvsbServer({ sdkKey: KEY, streaming: false, pollingInterval: 300_000 })
    await server.onReady()
    const refreshSpy = vi.spyOn(server, 'refreshDatafile')

    const snap = await server.utils.refreshAndSnapshot(ctx)
    expect(refreshSpy).toHaveBeenCalledOnce()
    expect(served.datafileCalls()).toBe(2)
    expect(snap.flags.checkout?.value).toBe(true)
    await server.close()
  })

  it('keeps serving the old datafile when the refresh fails', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(() => {
        calls++
        if (calls === 1) {
          return Promise.resolve(
            new Response(JSON.stringify(flagDatafile('2026-10-01T00:00:00Z', false)), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          )
        }
        return Promise.resolve(new Response('upstream down', { status: 503 }))
      })
    )
    const server = new AvsbServer({ sdkKey: KEY, streaming: false, pollingInterval: 300_000 })
    await server.onReady()

    const snap = await server.utils.snapshotFresh(ctx)
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(snap.datafileVersion).toBe('2026-10-01T00:00:00Z')
    expect(snap.flags.checkout?.value).toBe(false)
    await server.close()
  })
})
