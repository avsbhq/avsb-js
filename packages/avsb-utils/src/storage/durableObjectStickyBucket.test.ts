import { describe, expect, it, vi } from 'vitest'
import type { StickyAssignment } from '@avsbhq/core'
import {
  createDurableObjectStickyBucketService,
  type DurableObjectLike,
} from './durableObjectStickyBucket'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const assignment: StickyAssignment = {
  variationId: 'var_control',
  ruleId: 'rule_7',
  ruleType: 'ab_test',
  assignedAt: 1_700_000_000_000,
}

const assignmentB: StickyAssignment = {
  variationId: 'var_banner',
  ruleId: 'rule_8',
  ruleType: 'targeted_delivery',
  assignedAt: 1_700_000_010_000,
}

function makeMockStub(ok = true): {
  stub: DurableObjectLike
  fetch: ReturnType<typeof vi.fn>
} {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: ok ? 200 : 500 }))
  return { stub: { fetch }, fetch }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createDurableObjectStickyBucketService', () => {
  it('lookup returns null before any save (cold cache)', () => {
    const { stub } = makeMockStub()
    const svc = createDurableObjectStickyBucketService({ stub })

    expect(svc.lookup('user_1', 'flag_hero')).toBeNull()
  })

  it('lookup returns the assignment synchronously after save (write-through)', () => {
    const { stub } = makeMockStub()
    const svc = createDurableObjectStickyBucketService({ stub })

    svc.save('user_1', 'flag_hero', assignment)
    // Lookup must be synchronous — no await.
    expect(svc.lookup('user_1', 'flag_hero')).toEqual(assignment)
  })

  it('save issues a POST request to the DO stub with correct body', async () => {
    const { stub, fetch } = makeMockStub()
    const svc = createDurableObjectStickyBucketService({ stub })

    svc.save('user_1', 'flag_hero', assignment)
    await Promise.resolve()

    expect(fetch).toHaveBeenCalledOnce()
    const req = fetch.mock.calls[0][0] as Request
    expect(req.method).toBe('POST')
    expect(req.url).toContain('/save')

    const body = await req.json() as {
      userId: string
      flagKey: string
      assignment: StickyAssignment
    }
    expect(body.userId).toBe('user_1')
    expect(body.flagKey).toBe('flag_hero')
    expect(body.assignment).toEqual(assignment)
  })

  it('lookup returns null for a different userId or flagKey', () => {
    const { stub } = makeMockStub()
    const svc = createDurableObjectStickyBucketService({ stub })

    svc.save('user_1', 'flag_A', assignment)

    expect(svc.lookup('user_2', 'flag_A')).toBeNull()
    expect(svc.lookup('user_1', 'flag_B')).toBeNull()
  })

  it('DO fetch failure is silent — cache retains the in-process value', async () => {
    const failingStub: DurableObjectLike = {
      fetch: vi.fn().mockRejectedValue(new Error('DO unavailable')),
    }
    const svc = createDurableObjectStickyBucketService({ stub: failingStub })

    svc.save('user_1', 'flag_A', assignment)
    await Promise.resolve()

    // Persistence failed but in-memory cache must still hold the value.
    expect(svc.lookup('user_1', 'flag_A')).toEqual(assignment)
  })

  it('second save for the same key overwrites the first in the cache', () => {
    const { stub } = makeMockStub()
    const svc = createDurableObjectStickyBucketService({ stub })

    svc.save('user_1', 'flag_A', assignment)
    svc.save('user_1', 'flag_A', assignmentB)

    expect(svc.lookup('user_1', 'flag_A')).toEqual(assignmentB)
  })

  it('handles multiple flags per user independently', () => {
    const { stub } = makeMockStub()
    const svc = createDurableObjectStickyBucketService({ stub })

    svc.save('alice', 'flag_pricing', assignment)
    svc.save('alice', 'flag_checkout', assignmentB)
    svc.save('bob', 'flag_pricing', assignmentB)

    expect(svc.lookup('alice', 'flag_pricing')).toEqual(assignment)
    expect(svc.lookup('alice', 'flag_checkout')).toEqual(assignmentB)
    expect(svc.lookup('bob', 'flag_pricing')).toEqual(assignmentB)
    expect(svc.lookup('bob', 'flag_checkout')).toBeNull()
  })
})
