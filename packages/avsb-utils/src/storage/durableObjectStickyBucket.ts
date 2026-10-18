// Cloudflare Durable Object-backed StickyBucketService.
// Lookup:  GET  https://do/lookup?userId=...&flagKey=...
// Save:    POST https://do/save  body: { userId, flagKey, assignment }
//
// Write-through in-memory cache so `lookup` is synchronous (hot-path safe).
// Spec §8.8 / §2.4.

import type { StickyAssignment, StickyBucketService } from '@avsbhq/core'

// Minimal duck-typed Durable Object stub. Consumers pass the real
// `DurableObjectStub` from the Cloudflare Workers runtime binding.
export interface DurableObjectLike {
  fetch(request: Request): Promise<Response>
}

export interface DurableObjectStickyBucketOptions {
  stub: DurableObjectLike
}

// Syntactic placeholder for the Request constructor — Durable Object's
// fetch handler ignores hostname entirely, so any reserved-TLD URL works.
// Uses RFC 2606 `.invalid` to make "this is not real infrastructure"
// unambiguous to readers and security scanners.
const DO_BASE = 'https://do.invalid'

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

export function createDurableObjectStickyBucketService(
  opts: DurableObjectStickyBucketOptions
): StickyBucketService {
  // Write-through cache — cold reads before any save return null per spec.
  const cache = new Map<string, StickyAssignment>()

  return {
    lookup(userId: string, flagKey: string): StickyAssignment | null {
      return cache.get(`${userId}:${flagKey}`) ?? null
    },

    save(userId: string, flagKey: string, assignment: StickyAssignment): void {
      // Update cache immediately; persist to DO asynchronously.
      cache.set(`${userId}:${flagKey}`, assignment)
      const body = JSON.stringify({ userId, flagKey, assignment })
      opts.stub
        .fetch(
          new Request(`${DO_BASE}/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
        )
        .catch(() => {
          // Best-effort. Cache retains the in-process value.
        })
    },
  }
}
