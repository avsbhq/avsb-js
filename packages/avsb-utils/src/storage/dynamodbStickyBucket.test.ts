import { describe, expect, it, vi } from 'vitest'
import type { StickyAssignment } from '@avsbhq/core'
import {
  createDynamoDBStickyBucketService,
  type DynamoDBStickyLike,
} from './dynamodbStickyBucket'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const assignment: StickyAssignment = {
  variationId: 'var_control',
  ruleId: 'rule_42',
  ruleType: 'ab_test',
  assignedAt: 1_700_000_000_000,
}

const assignmentB: StickyAssignment = {
  variationId: 'var_treatment',
  ruleId: 'rule_43',
  ruleType: 'targeted_delivery',
  assignedAt: 1_700_000_001_000,
}

function makeMockClient(): {
  client: DynamoDBStickyLike
  putItem: ReturnType<typeof vi.fn>
  getItem: ReturnType<typeof vi.fn>
} {
  const putItem = vi.fn().mockResolvedValue({})
  const getItem = vi.fn().mockResolvedValue({ Item: undefined })
  return { client: { putItem, getItem }, putItem, getItem }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('createDynamoDBStickyBucketService', () => {
  it('lookup returns null before any save (cold cache)', () => {
    const { client } = makeMockClient()
    const svc = createDynamoDBStickyBucketService({
      client,
      tableName: 'StickyBuckets',
    })

    expect(svc.lookup('user_1', 'flag_experiment')).toBeNull()
  })

  it('lookup returns the assignment after save (write-through cache)', () => {
    const { client } = makeMockClient()
    const svc = createDynamoDBStickyBucketService({
      client,
      tableName: 'StickyBuckets',
    })

    svc.save('user_1', 'flag_experiment', assignment)
    expect(svc.lookup('user_1', 'flag_experiment')).toEqual(assignment)
  })

  it('save fires a putItem call with the correct key and JSON body', async () => {
    const { client, putItem } = makeMockClient()
    const svc = createDynamoDBStickyBucketService({
      client,
      tableName: 'StickyBuckets',
    })

    svc.save('user_1', 'flag_experiment', assignment)
    // Let the async putItem promise resolve.
    await Promise.resolve()

    expect(putItem).toHaveBeenCalledOnce()
    const call = putItem.mock.calls[0][0] as {
      TableName: string
      Item: Record<string, { S: string }>
    }
    expect(call.TableName).toBe('StickyBuckets')
    expect(call.Item['pk'].S).toBe('user_1#flag_experiment')
    expect(JSON.parse(call.Item['data'].S)).toEqual(assignment)
  })

  it('lookup returns null for a different userId/flagKey pair', () => {
    const { client } = makeMockClient()
    const svc = createDynamoDBStickyBucketService({
      client,
      tableName: 'StickyBuckets',
    })

    svc.save('user_1', 'flag_A', assignment)
    expect(svc.lookup('user_2', 'flag_A')).toBeNull()
    expect(svc.lookup('user_1', 'flag_B')).toBeNull()
  })

  it('save overwrites an earlier assignment for the same userId+flagKey', () => {
    const { client } = makeMockClient()
    const svc = createDynamoDBStickyBucketService({
      client,
      tableName: 'StickyBuckets',
    })

    svc.save('user_1', 'flag_A', assignment)
    svc.save('user_1', 'flag_A', assignmentB)

    expect(svc.lookup('user_1', 'flag_A')).toEqual(assignmentB)
  })

  it('putItem failure is silent — cache still retains the value', async () => {
    const failingClient: DynamoDBStickyLike = {
      putItem: vi.fn().mockRejectedValue(new Error('ServiceUnavailable')),
      getItem: vi.fn().mockResolvedValue({ Item: undefined }),
    }
    const svc = createDynamoDBStickyBucketService({
      client: failingClient,
      tableName: 'StickyBuckets',
    })

    svc.save('user_1', 'flag_experiment', assignment)
    await Promise.resolve() // Let rejection settle.

    // The in-memory cache must survive a persistence error.
    expect(svc.lookup('user_1', 'flag_experiment')).toEqual(assignment)
  })

  it('handles multiple flags per user independently', () => {
    const { client } = makeMockClient()
    const svc = createDynamoDBStickyBucketService({
      client,
      tableName: 'StickyBuckets',
    })

    svc.save('user_1', 'flag_A', assignment)
    svc.save('user_1', 'flag_B', assignmentB)

    expect(svc.lookup('user_1', 'flag_A')).toEqual(assignment)
    expect(svc.lookup('user_1', 'flag_B')).toEqual(assignmentB)
  })
})
