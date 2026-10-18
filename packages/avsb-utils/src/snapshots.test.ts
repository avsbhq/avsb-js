import { describe, expect, it, vi } from 'vitest'
import { createFlag } from '@avsbhq/core'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'
import {
  hydrateBootstrap,
  serializeBootstrap,
  snapshot,
  snapshotFresh,
} from './snapshots'

function buildClient(opts?: { withDatafile?: boolean }) {
  const flag = createFlag<boolean>({
    value: true,
    variationKey: 'on',
    source: 'rule',
    ruleId: 'r1',
    ruleType: 'ab_test',
    reasons: ['matched audience A'],
    durationMicros: 100,
  })
  const datafile: FlagDatafile | null = opts?.withDatafile
    ? {
        version: 2,
        projectType: 'FEATURE_FLAG',
        sdkKey: 'sdk',
        environmentKey: 'prod',
        publishedAt: '2026-05-28T00:00:00Z',
        collectEndpoint: 'https://collect',
        flags: [],
        audiences: [],
      }
    : null
  return {
    getAllFlags: vi.fn(() => ({ flagA: flag })),
    getDatafile: () => datafile,
    getCurrentContext: () => ({ kind: 'user', key: 'u_1' }) as EvalContext,
    refresh: vi.fn(async () => undefined),
  }
}

describe('snapshot', () => {
  it('returns a snapshot keyed by flag key', () => {
    const client = buildClient()
    const snap = snapshot(client)
    expect(snap.flags.flagA.value).toBe(true)
  })

  it('does not fire exposures during snapshot', () => {
    const client = buildClient()
    snapshot(client)
    expect(client.getAllFlags).toHaveBeenCalledWith(
      expect.objectContaining({ fireExposures: false })
    )
  })

  it('includes the context summary', () => {
    const client = buildClient()
    const snap = snapshot(client)
    expect(snap.contextSummary).toEqual([{ kind: 'user', key: 'u_1' }])
  })
})

describe('snapshotFresh', () => {
  it('refreshes before snapshotting', async () => {
    const client = buildClient()
    await snapshotFresh(client)
    expect(client.refresh).toHaveBeenCalled()
  })
})

describe('serializeBootstrap + hydrateBootstrap', () => {
  it('produces a versioned blob the target can hydrate', async () => {
    const client = buildClient({ withDatafile: true })
    const blob = await serializeBootstrap(client, undefined, {
      includeDatafile: true,
    })
    expect(blob.format).toBe('avsb-bootstrap-v1')
    expect(blob.datafile).toBeDefined()

    const target = {
      applyDatafile: vi.fn(),
      applySnapshot: vi.fn(),
    }
    const result = hydrateBootstrap(target, blob)
    expect(target.applyDatafile).toHaveBeenCalled()
    expect(target.applySnapshot).toHaveBeenCalledWith(blob.snapshot)
    expect(result).toEqual({
      datafileApplied: true,
      snapshotApplied: true,
      flagCount: 1,
    })
  })

  it('rejects malformed blobs', () => {
    expect(() =>
      hydrateBootstrap(
        { applySnapshot: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test feeds malformed input
        { format: 'wrong' } as any
      )
    ).toThrow(/Invalid bootstrap blob/)
  })

  it('omits datafile when includeDatafile is false', async () => {
    const client = buildClient({ withDatafile: true })
    const blob = await serializeBootstrap(client)
    expect(blob.datafile).toBeUndefined()
  })

  it('reports snapshot-only hydration when the target has no applyDatafile hook', async () => {
    const client = buildClient({ withDatafile: true })
    const blob = await serializeBootstrap(client)
    const target = { applySnapshot: vi.fn() }

    const result = hydrateBootstrap(target, blob)

    expect(result.datafileApplied).toBe(false)
    expect(result.snapshotApplied).toBe(true)
  })

  it('reports datafile-only hydration for a target that refuses snapshots', async () => {
    const client = buildClient({ withDatafile: true })
    const blob = await serializeBootstrap(client, undefined, {
      includeDatafile: true,
    })
    const target = { applyDatafile: vi.fn() }

    const result = hydrateBootstrap(target, blob)

    expect(result.datafileApplied).toBe(true)
    expect(result.snapshotApplied).toBe(false)
  })

  it('throws instead of silently doing nothing when a snapshot-only blob meets a server client', async () => {
    // The exact shape of report 02 §5.6: the documented SSR handoff was a
    // no-op for a whole release because neither hook existed.
    const client = buildClient({ withDatafile: true })
    const blob = await serializeBootstrap(client)

    expect(() => hydrateBootstrap({ applyDatafile: vi.fn() }, blob)).toThrow(
      /carries no "datafile" and this client does not adopt pre-evaluated snapshots/
    )
  })

  it('names the applyDatafile gap when the blob does carry a datafile', async () => {
    const client = buildClient({ withDatafile: true })
    const blob = await serializeBootstrap(client, undefined, {
      includeDatafile: true,
    })

    expect(() => hydrateBootstrap({}, blob)).toThrow(/no applyDatafile hook/)
  })
})
