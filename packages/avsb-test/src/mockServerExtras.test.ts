import { describe, expect, it, vi } from 'vitest'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'
import { createMockServer } from './createMockServer'
import { createMockServerUtils } from './mockServerExtras'
import type { MockUtilsHost } from './mockServerExtras'

// FU-39: the mock's utils adapter had no `refresh`, like the real server
// adapter, so `snapshotFresh` never refreshed under test either. These tests
// pin the new wiring: the refresh is counted and fires `configUpdate`.

const ctx: EvalContext = { kind: 'user', key: 'u_1' }

describe('mock server utils refresh', () => {
  it('snapshotFresh refreshes once and reflects a value changed between calls', async () => {
    const server = createMockServer({ flags: { checkout: false } })
    const updates = vi.fn()
    server.on('configUpdate', updates)

    expect(server.utils.snapshot(ctx).flags.checkout?.value).toBe(false)
    server._setFlag('checkout', true)

    const fresh = await server.utils.snapshotFresh(ctx)
    expect(server._refreshCount()).toBe(1)
    expect(updates).toHaveBeenCalledOnce()
    expect(updates.mock.calls[0][0]).toMatchObject({ reason: 'manual' })
    expect(fresh.flags.checkout?.value).toBe(true)
  })

  it('refreshAndSnapshot reports the datafile adopted through hydrateBootstrap', async () => {
    const server = createMockServer()
    const datafile: FlagDatafile = {
      version: 2,
      projectType: 'FEATURE_FLAG',
      sdkKey: 'sdk',
      environmentKey: 'test',
      publishedAt: '2026-10-02T00:00:00Z',
      collectEndpoint: 'https://collect.test',
      flags: [],
      audiences: [],
    }
    server.applyDatafileBootstrap(datafile)

    const snap = await server.utils.refreshAndSnapshot(ctx)
    expect(server._refreshCount()).toBe(1)
    expect(snap.datafileVersion).toBe('2026-10-02T00:00:00Z')
  })

  it('a plain snapshot does not refresh', () => {
    const server = createMockServer({ flags: { checkout: true } })
    server.utils.snapshot(ctx)
    expect(server._refreshCount()).toBe(0)
  })

  it('propagates a failing host refresh instead of swallowing it', async () => {
    const host: MockUtilsHost = {
      getAllFlags: () => ({}),
      track: () => undefined,
      on: () => () => undefined,
      getDatafile: () => null,
      applyDatafileBootstrap: () => undefined,
      refreshDatafile: () => Promise.reject(new Error('refresh failed')),
    }
    const utils = createMockServerUtils(host)
    await expect(utils.snapshotFresh(ctx)).rejects.toThrow('refresh failed')
  })
})
