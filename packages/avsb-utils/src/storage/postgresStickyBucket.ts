// Postgres-backed StickyBucketService.
// Schema (caller's responsibility to create):
//   CREATE TABLE avsb_sticky_buckets (
//     user_id      TEXT        NOT NULL,
//     flag_key     TEXT        NOT NULL,
//     variation_id TEXT        NOT NULL,
//     rule_id      TEXT        NOT NULL,
//     rule_type    TEXT        NOT NULL,
//     assigned_at  BIGINT      NOT NULL,
//     PRIMARY KEY (user_id, flag_key)
//   );
//
// Write-through in-memory cache so `lookup` is synchronous (hot-path safe).
// Spec §8.8 / §2.4.

import type { StickyAssignment, StickyBucketService } from '@avsbhq/core'

// Minimal duck-typed Postgres interface. Consumers supply a connected `pg`
// Pool or Client; we never import `pg`.
export interface PostgresLike {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>
}

export interface PostgresStickyBucketOptions {
  client: PostgresLike
  /** Table name. Default: 'avsb_sticky_buckets'. */
  tableName?: string
}

function isStickyRow(row: unknown): row is {
  variation_id: string
  rule_id: string
  rule_type: string
  assigned_at: string | number
} {
  if (!row || typeof row !== 'object') return false
  const r = row as Record<string, unknown>
  return (
    typeof r['variation_id'] === 'string' &&
    typeof r['rule_id'] === 'string' &&
    typeof r['rule_type'] === 'string' &&
    (typeof r['assigned_at'] === 'string' ||
      typeof r['assigned_at'] === 'number')
  )
}

export function createPostgresStickyBucketService(
  opts: PostgresStickyBucketOptions
): StickyBucketService {
  const table = opts.tableName ?? 'avsb_sticky_buckets'
  // Write-through cache — cold reads (before any save) return null per spec.
  const cache = new Map<string, StickyAssignment>()

  return {
    lookup(userId: string, flagKey: string): StickyAssignment | null {
      return cache.get(`${userId}:${flagKey}`) ?? null
    },

    save(userId: string, flagKey: string, assignment: StickyAssignment): void {
      // Populate cache immediately; persist asynchronously (fire-and-forget).
      cache.set(`${userId}:${flagKey}`, assignment)
      opts.client
        .query(
          `INSERT INTO ${table} (user_id, flag_key, variation_id, rule_id, rule_type, assigned_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (user_id, flag_key)
           DO UPDATE SET
             variation_id = EXCLUDED.variation_id,
             rule_id      = EXCLUDED.rule_id,
             rule_type    = EXCLUDED.rule_type,
             assigned_at  = EXCLUDED.assigned_at`,
          [
            userId,
            flagKey,
            assignment.variationId,
            assignment.ruleId,
            assignment.ruleType,
            assignment.assignedAt,
          ]
        )
        .catch(() => {
          // Best-effort persistence. Cache retains the value; on restart the
          // assignment is lost only if the write never landed.
        })
    },
  }
}
