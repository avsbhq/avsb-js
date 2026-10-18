import { describe, expect, it } from 'vitest'
import { createFlag } from '@avsbhq/core'
import type { Flag } from '@avsbhq/core'
import { createSnapshotStore, snapshotReason } from './snapshotStore'
import type { FlagSnapshot } from './snapshots'

function serverFlag(value: unknown, overrides: Partial<Flag> = {}): Flag {
  return createFlag<unknown>({
    value,
    variationKey: 'on',
    source: 'rule',
    ruleId: 'r1',
    ruleType: 'ab_test',
    reasons: ['matched audience paid-users'],
    evaluatedAt: 1_700_000_000_000,
    durationMicros: 42,
    ...overrides,
  })
}

function makeSnapshot(flags: Record<string, Flag>): FlagSnapshot {
  return {
    capturedAt: 1_700_000_000_000,
    datafileVersion: '2026-05-28T00:00:00.000Z',
    flags,
    contextSummary: [{ kind: 'user', key: 'u_1' }],
  }
}

describe('createSnapshotStore', () => {
  it('is inactive until a snapshot is adopted', () => {
    const store = createSnapshotStore()
    expect(store.isActive()).toBe(false)
    expect(store.current()).toBeNull()
    expect(store.read('checkout-v2', false)).toBeNull()
    expect(store.readAll()).toEqual({})
    expect(store.keys()).toEqual([])
  })

  it('answers reads with the server-evaluated value once adopted', () => {
    const store = createSnapshotStore()
    store.adopt(makeSnapshot({ 'checkout-v2': serverFlag(true) }))

    const flag = store.read<boolean>('checkout-v2', false)

    expect(store.isActive()).toBe(true)
    expect(flag?.value).toBe(true)
    expect(flag?.variationKey).toBe('on')
  })

  it('keeps the source the server recorded instead of inventing one', () => {
    const store = createSnapshotStore()
    store.adopt(
      makeSnapshot({
        'from-rule': serverFlag(true),
        'from-default': serverFlag(false, {
          source: 'default',
          variationKey: null,
          ruleId: null,
          ruleType: null,
        }),
        'from-holdout': serverFlag(false, { source: 'holdout' }),
      }),
    )

    expect(store.read('from-rule', false)?.source).toBe('rule')
    expect(store.read('from-default', true)?.source).toBe('default')
    expect(store.read('from-holdout', true)?.source).toBe('holdout')
  })

  it('appends one provenance reason naming the snapshot, keeping the server reasons', () => {
    const snap = makeSnapshot({ 'checkout-v2': serverFlag(true) })
    const store = createSnapshotStore()
    store.adopt(snap)

    const reasons = store.read('checkout-v2', false)?.reasons ?? []

    expect(reasons[0]).toBe('matched audience paid-users')
    expect(reasons[reasons.length - 1]).toBe(snapshotReason(snap))
    expect(reasons[reasons.length - 1]).toContain('server bootstrap snapshot')
    expect(reasons[reasons.length - 1]).toContain('user:u_1')
  })

  it('returns the SAME object across reads so useSyncExternalStore cannot loop', () => {
    const store = createSnapshotStore()
    store.adopt(makeSnapshot({ 'checkout-v2': serverFlag(true) }))

    const first = store.read('checkout-v2', false)
    const second = store.read('checkout-v2', false)

    expect(first).toBe(second)
    expect(store.readAll()['checkout-v2']).toBe(first)
  })

  it('returns null for a key the snapshot never carried, rather than a fabricated value', () => {
    const store = createSnapshotStore()
    store.adopt(makeSnapshot({ 'checkout-v2': serverFlag(true) }))

    expect(store.read('never-evaluated', 'fallback')).toBeNull()
  })

  it('serves every key through readAll and keys', () => {
    const store = createSnapshotStore()
    store.adopt(
      makeSnapshot({
        a: serverFlag(1),
        b: serverFlag('two'),
      }),
    )

    expect(store.keys().sort()).toEqual(['a', 'b'])
    expect(store.readAll().a.value).toBe(1)
    expect(store.readAll().b.value).toBe('two')
  })

  it('stops answering after release, so a real datafile takes over', () => {
    const store = createSnapshotStore()
    store.adopt(makeSnapshot({ 'checkout-v2': serverFlag(true) }))
    store.release()

    expect(store.isActive()).toBe(false)
    expect(store.read('checkout-v2', false)).toBeNull()
    expect(store.readAll()).toEqual({})
  })

  it('replaces a previously adopted snapshot, including the cached objects', () => {
    const store = createSnapshotStore()
    store.adopt(makeSnapshot({ 'checkout-v2': serverFlag(true) }))
    const first = store.read('checkout-v2', false)

    store.adopt(makeSnapshot({ 'checkout-v2': serverFlag(false) }))
    const second = store.read('checkout-v2', true)

    expect(first).not.toBe(second)
    expect(second?.value).toBe(false)
  })

  it('preserves the server evaluation timestamp rather than restamping on read', () => {
    const store = createSnapshotStore()
    store.adopt(makeSnapshot({ 'checkout-v2': serverFlag(true) }))

    const flag = store.read('checkout-v2', false)

    expect(flag?.evaluatedAt).toBe(1_700_000_000_000)
    expect(flag?.durationMicros).toBe(42)
  })
})

describe('snapshotReason', () => {
  it('names the capture time, the contexts, and the datafile version', () => {
    const reason = snapshotReason(
      makeSnapshot({ a: serverFlag(true) }),
    )
    expect(reason).toContain('2023-11-14T22:13:20.000Z')
    expect(reason).toContain('user:u_1')
    expect(reason).toContain('2026-05-28T00:00:00.000Z')
  })

  it('omits the context clause when the snapshot summarised none', () => {
    const reason = snapshotReason({
      capturedAt: 1_700_000_000_000,
      datafileVersion: '',
      flags: {},
      contextSummary: [],
    })
    expect(reason).not.toContain(' for ')
    expect(reason).not.toContain('(datafile')
  })
})
