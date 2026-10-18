// DynamoDB-backed StickyBucketService.
// Key layout: PK = `{userId}#{flagKey}`, data attribute = JSON-serialised
// StickyAssignment. Write-through in-memory cache so `lookup` is sync.
// Spec §8.8 / §2.4.

import type { StickyAssignment, StickyBucketService } from '@avsbhq/core'

// Minimal duck-typed DynamoDB interface (same family as storage.ts
// DynamoDBClientLike but typed for the operations this module needs).
export interface DynamoDBStickyLike {
  getItem(opts: {
    TableName: string
    Key: Record<string, { S: string }>
  }): Promise<{ Item?: Record<string, { S?: string }> }>

  putItem(opts: {
    TableName: string
    Item: Record<string, { S: string }>
  }): Promise<unknown>
}

export interface DynamoDBStickyBucketOptions {
  client: DynamoDBStickyLike
  /** DynamoDB table name. PK attribute: `pk` (String). */
  tableName: string
}

function compositeKey(userId: string, flagKey: string): string {
  return `${userId}#${flagKey}`
}

function isStickyAssignment(v: unknown): v is StickyAssignment {
  if (!v || typeof v !== 'object') return false
  const obj = v as Record<string, unknown>
  return (
    typeof obj['variationId'] === 'string' &&
    typeof obj['ruleId'] === 'string' &&
    typeof obj['ruleType'] === 'string' &&
    typeof obj['assignedAt'] === 'number'
  )
}

export function createDynamoDBStickyBucketService(
  opts: DynamoDBStickyBucketOptions
): StickyBucketService {
  // Write-through cache: populated on save, cold reads return null per spec.
  const cache = new Map<string, StickyAssignment>()

  return {
    lookup(userId: string, flagKey: string): StickyAssignment | null {
      return cache.get(compositeKey(userId, flagKey)) ?? null
    },

    save(userId: string, flagKey: string, assignment: StickyAssignment): void {
      const pk = compositeKey(userId, flagKey)
      // Write-through: update cache immediately, persist asynchronously.
      cache.set(pk, assignment)
      opts.client
        .putItem({
          TableName: opts.tableName,
          Item: {
            pk: { S: pk },
            data: { S: JSON.stringify(assignment) },
          },
        })
        .catch(() => {
          // Best-effort — cache already has the value; persistence failure
          // is tolerated (SDK degrades to re-bucketing on restart, not crash).
        })
    },
  }
}
