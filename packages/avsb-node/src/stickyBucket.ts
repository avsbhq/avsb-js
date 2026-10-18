import type { StickyBucketService, StickyAssignment, Logger } from './types'
import { noopLogger } from './logger'

// --- In-memory implementation (no external deps) ---

export class InMemoryStickyBucketService implements StickyBucketService {
  private cache = new Map<string, StickyAssignment>()

  private key(userId: string, flagKey: string): string {
    return `${userId}:${flagKey}`
  }

  lookup(userId: string, flagKey: string): StickyAssignment | null {
    return this.cache.get(this.key(userId, flagKey)) ?? null
  }

  save(userId: string, flagKey: string, assignment: StickyAssignment): void {
    this.cache.set(this.key(userId, flagKey), assignment)
  }
}

// --- Redis-backed implementation ---

export interface RedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>
}

export interface RedisStickyBucketOptions {
  redis: RedisLike
  prefix?: string
  ttl?: number
  cacheSize?: number
  logger?: Logger
}

function isStickyAssignment(value: unknown): value is StickyAssignment {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.variationId === 'string' &&
    typeof v.ruleId === 'string' &&
    typeof v.ruleType === 'string' &&
    typeof v.assignedAt === 'number'
  )
}

export class RedisStickyBucketService implements StickyBucketService {
  private redis: RedisLike
  private prefix: string
  private ttl: number
  private maxCacheSize: number
  private logger: Logger
  private cache = new Map<string, StickyAssignment>()

  constructor(options: RedisStickyBucketOptions) {
    this.redis = options.redis
    this.prefix = options.prefix ?? 'avsb:sticky:'
    this.ttl = options.ttl ?? 2_592_000 // 30 days
    this.maxCacheSize = options.cacheSize ?? 10_000
    this.logger = options.logger ?? noopLogger
  }

  private redisKey(userId: string, flagKey: string): string {
    return `${this.prefix}${userId}:${flagKey}`
  }

  private cacheKey(userId: string, flagKey: string): string {
    return `${userId}:${flagKey}`
  }

  lookup(userId: string, flagKey: string): StickyAssignment | null {
    const ck = this.cacheKey(userId, flagKey)
    const cached = this.cache.get(ck)
    if (cached !== undefined) return cached

    this.backgroundFetch(userId, flagKey)
    return null
  }

  save(userId: string, flagKey: string, assignment: StickyAssignment): void {
    const ck = this.cacheKey(userId, flagKey)

    this.cache.set(ck, assignment)
    this.evictIfNeeded()

    const rk = this.redisKey(userId, flagKey)
    const serialized = JSON.stringify(assignment)
    this.redis.set(rk, serialized, { EX: this.ttl }).catch((e) => {
      this.logger.error('Redis sticky bucket save failed', {
        key: rk,
        error: String(e),
      })
    })
  }

  private backgroundFetch(userId: string, flagKey: string): void {
    const rk = this.redisKey(userId, flagKey)
    const ck = this.cacheKey(userId, flagKey)
    this.redis.get(rk).then((value) => {
      if (value === null) return
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        this.logger.warn('Redis sticky bucket value is not valid JSON', { key: rk })
        return
      }
      if (!isStickyAssignment(parsed)) {
        this.logger.warn('Redis sticky bucket value missing required fields', { key: rk })
        return
      }
      this.cache.set(ck, parsed)
      this.evictIfNeeded()
    }).catch((e) => {
      this.logger.error('Redis sticky bucket fetch failed', {
        key: rk,
        error: String(e),
      })
    })
  }

  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxCacheSize) return
    const firstKey = this.cache.keys().next().value
    if (firstKey !== undefined) {
      this.cache.delete(firstKey)
    }
  }
}
