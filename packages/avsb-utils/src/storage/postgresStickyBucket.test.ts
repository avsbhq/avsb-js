import { describe, expect, it, vi } from 'vitest'
import type { StickyAssignment } from '@avsbhq/core'
import {
  createPostgresStickyBucketService,
  type PostgresLike,
} from './postgresStickyBucket'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const assignment: StickyAssignment = {
  variationId: 'var_control',
  ruleId: 'rule_99',
  ruleType: 'ab_test',
  assignedAt: 1_700_000_000_000,
}

const assignmentB: StickyAssignment = {
  variationId: 'var_treatment',
  ruleId: 'rule_100',
  ruleType: 'targeted_delivery',
  assignedAt: 1_700_000_005_000,
}

function makeMockClient(): {
  client: PostgresLike
  query: ReturnType<typeof vi.fn>
} {
  const query = vi.fn().mockResolvedValue({ rows: [] })
  return { client: { query }, query }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createPostgresStickyBucketService', () => {
  it('lookup returns null before any save (cold cache)', () => {
    const { client } = makeMockClient()
    const svc = createPostgresStickyBucketService({ client })

    expect(svc.lookup('user_1', 'flag_checkout')).toBeNull()
  })

  it('lookup returns the assignment immediately after save (write-through)', () => {
    const { client } = makeMockClient()
    const svc = createPostgresStickyBucketService({ client })

    svc.save('user_1', 'flag_checkout', assignment)
    expect(svc.lookup('user_1', 'flag_checkout')).toEqual(assignment)
  })

  it('save issues an UPSERT query with the correct parameters', async () => {
    const { client, query } = makeMockClient()
    const svc = createPostgresStickyBucketService({
      client,
      tableName: 'custom_sticky',
    })

    svc.save('user_1', 'flag_checkout', assignment)
    await Promise.resolve()

    expect(query).toHaveBeenCalledOnce()
    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('custom_sticky')
    expect(sql).toContain('ON CONFLICT')
    expect(params[0]).toBe('user_1')
    expect(params[1]).toBe('flag_checkout')
    expect(params[2]).toBe(assignment.variationId)
    expect(params[3]).toBe(assignment.ruleId)
    expect(params[4]).toBe(assignment.ruleType)
    expect(params[5]).toBe(assignment.assignedAt)
  })

  it('lookup returns null for a different user or flag', () => {
    const { client } = makeMockClient()
    const svc = createPostgresStickyBucketService({ client })

    svc.save('user_1', 'flag_A', assignment)

    expect(svc.lookup('user_2', 'flag_A')).toBeNull()
    expect(svc.lookup('user_1', 'flag_B')).toBeNull()
  })

  it('a second save for the same key overwrites the first in the cache', () => {
    const { client } = makeMockClient()
    const svc = createPostgresStickyBucketService({ client })

    svc.save('user_1', 'flag_A', assignment)
    svc.save('user_1', 'flag_A', assignmentB)

    expect(svc.lookup('user_1', 'flag_A')).toEqual(assignmentB)
  })

  it('query failure is silent — cache still retains the assignment', async () => {
    const failingClient: PostgresLike = {
      query: vi.fn().mockRejectedValue(new Error('Connection timeout')),
    }
    const svc = createPostgresStickyBucketService({ client: failingClient })

    svc.save('user_1', 'flag_A', assignment)
    await Promise.resolve()

    expect(svc.lookup('user_1', 'flag_A')).toEqual(assignment)
  })

  it('handles multiple flags per user independently', () => {
    const { client } = makeMockClient()
    const svc = createPostgresStickyBucketService({ client })

    svc.save('alice', 'flag_pricing', assignment)
    svc.save('alice', 'flag_checkout', assignmentB)
    svc.save('bob', 'flag_pricing', assignmentB)

    expect(svc.lookup('alice', 'flag_pricing')).toEqual(assignment)
    expect(svc.lookup('alice', 'flag_checkout')).toEqual(assignmentB)
    expect(svc.lookup('bob', 'flag_pricing')).toEqual(assignmentB)
    expect(svc.lookup('bob', 'flag_checkout')).toBeNull()
  })
})
