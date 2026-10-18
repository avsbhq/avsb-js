import {
  InMemoryStickyBucketService,
  RedisStickyBucketService,
} from './stickyBucket'
import type { RedisLike } from './stickyBucket'
import type { Logger, StickyAssignment } from './types'

function makeAssignment(overrides: Partial<StickyAssignment> = {}): StickyAssignment {
  return {
    variationId: 'variation-1',
    ruleId: 'rule-1',
    ruleType: 'ab_test',
    assignedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function createMockRedis(): RedisLike & { _store: Map<string, string> } {
  const store = new Map<string, string>()
  return {
    _store: store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
  }
}

function createMockLogger(): Logger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child() { return logger },
  }
  return logger
}

// --- InMemoryStickyBucketService ---

describe('InMemoryStickyBucketService', () => {
  it('returns null for unknown user+flag', () => {
    const svc = new InMemoryStickyBucketService()
    expect(svc.lookup('user-1', 'flag-a')).toBeNull()
  })

  it('stores and returns the saved assignment', () => {
    const svc = new InMemoryStickyBucketService()
    const assignment = makeAssignment()
    svc.save('user-1', 'flag-a', assignment)
    expect(svc.lookup('user-1', 'flag-a')).toEqual(assignment)
  })

  it('keeps separate assignments for different users on the same flag', () => {
    const svc = new InMemoryStickyBucketService()
    const a1 = makeAssignment({ variationId: 'v1' })
    const a2 = makeAssignment({ variationId: 'v2' })
    svc.save('user-1', 'flag-a', a1)
    svc.save('user-2', 'flag-a', a2)
    expect(svc.lookup('user-1', 'flag-a')).toEqual(a1)
    expect(svc.lookup('user-2', 'flag-a')).toEqual(a2)
  })

  it('keeps separate assignments for different flags on the same user', () => {
    const svc = new InMemoryStickyBucketService()
    const a1 = makeAssignment({ variationId: 'v1' })
    const a2 = makeAssignment({ variationId: 'v2' })
    svc.save('user-1', 'flag-a', a1)
    svc.save('user-1', 'flag-b', a2)
    expect(svc.lookup('user-1', 'flag-a')).toEqual(a1)
    expect(svc.lookup('user-1', 'flag-b')).toEqual(a2)
  })

  it('overwrites previous assignment for the same user+flag', () => {
    const svc = new InMemoryStickyBucketService()
    svc.save('user-1', 'flag-a', makeAssignment({ variationId: 'v1' }))
    svc.save('user-1', 'flag-a', makeAssignment({ variationId: 'v2' }))
    expect(svc.lookup('user-1', 'flag-a')?.variationId).toBe('v2')
  })

  it('preserves ruleId and ruleType so orphan detection has the full provenance', () => {
    // Spec §4 fix #9: sticky payload must carry rule provenance so a deleted
    // rule can be detected as orphaned instead of silently re-bucketing.
    const svc = new InMemoryStickyBucketService()
    svc.save('user-1', 'flag-a', makeAssignment({
      variationId: 'v_treat',
      ruleId: 'rule_42',
      ruleType: 'ab_test',
      assignedAt: 1_700_000_000_000,
    }))
    const stored = svc.lookup('user-1', 'flag-a')
    expect(stored).not.toBeNull()
    expect(stored!.ruleId).toBe('rule_42')
    expect(stored!.ruleType).toBe('ab_test')
    expect(stored!.assignedAt).toBe(1_700_000_000_000)
  })
})

// --- RedisStickyBucketService ---

describe('RedisStickyBucketService', () => {
  it('returns null on cache miss without blocking on Redis', () => {
    const redis = createMockRedis()
    const svc = new RedisStickyBucketService({ redis })
    const result = svc.lookup('user-1', 'flag-a')
    expect(result).toBeNull()
  })

  it('returns cached assignment on cache hit after save()', () => {
    const redis = createMockRedis()
    const svc = new RedisStickyBucketService({ redis })
    const assignment = makeAssignment()
    svc.save('user-1', 'flag-a', assignment)
    expect(svc.lookup('user-1', 'flag-a')).toEqual(assignment)
  })

  it('writes JSON-serialised assignment to both in-memory cache and Redis on save()', async () => {
    const redis = createMockRedis()
    const svc = new RedisStickyBucketService({ redis })
    const assignment = makeAssignment({ variationId: 'v1' })
    svc.save('user-1', 'flag-a', assignment)

    expect(svc.lookup('user-1', 'flag-a')).toEqual(assignment)

    await new Promise((r) => setTimeout(r, 0))
    const stored = redis._store.get('avsb:sticky:user-1:flag-a')
    expect(stored).toBeDefined()
    expect(JSON.parse(stored!)).toEqual(assignment)
  })

  it('calls Redis set with correct prefix and TTL', async () => {
    const redis = createMockRedis()
    const svc = new RedisStickyBucketService({
      redis,
      prefix: 'custom:',
      ttl: 3600,
    })
    const assignment = makeAssignment({ variationId: 'v1' })
    svc.save('user-1', 'flag-a', assignment)

    await new Promise((r) => setTimeout(r, 0))
    expect(redis.set).toHaveBeenCalledWith(
      'custom:user-1:flag-a',
      JSON.stringify(assignment),
      { EX: 3600 },
    )
  })

  it('populates cache from background fetch after first lookup miss', async () => {
    const redis = createMockRedis()
    const assignment = makeAssignment({ variationId: 'v1' })
    redis._store.set('avsb:sticky:user-1:flag-a', JSON.stringify(assignment))

    const svc = new RedisStickyBucketService({ redis })

    expect(svc.lookup('user-1', 'flag-a')).toBeNull()

    await new Promise((r) => setTimeout(r, 0))

    expect(svc.lookup('user-1', 'flag-a')).toEqual(assignment)
  })

  it('warns and skips when Redis returns a value that is not valid JSON', async () => {
    const redis = createMockRedis()
    const logger = createMockLogger()
    redis._store.set('avsb:sticky:user-1:flag-a', 'not-json-{{')

    const svc = new RedisStickyBucketService({ redis, logger })
    expect(svc.lookup('user-1', 'flag-a')).toBeNull()
    await new Promise((r) => setTimeout(r, 0))

    expect(logger.warn).toHaveBeenCalled()
    expect(svc.lookup('user-1', 'flag-a')).toBeNull()
  })

  it('warns and skips when Redis JSON does not match StickyAssignment shape', async () => {
    const redis = createMockRedis()
    const logger = createMockLogger()
    redis._store.set('avsb:sticky:user-1:flag-a', JSON.stringify({ variationId: 'v1' }))

    const svc = new RedisStickyBucketService({ redis, logger })
    svc.lookup('user-1', 'flag-a')
    await new Promise((r) => setTimeout(r, 0))

    expect(logger.warn).toHaveBeenCalled()
    expect(svc.lookup('user-1', 'flag-a')).toBeNull()
  })

  it('catches and logs Redis errors on save', async () => {
    const redis = createMockRedis()
    const logger = createMockLogger()
    redis.set = vi.fn().mockRejectedValue(new Error('connection refused'))

    const svc = new RedisStickyBucketService({ redis, logger })

    expect(() => svc.save('user-1', 'flag-a', makeAssignment())).not.toThrow()

    await new Promise((r) => setTimeout(r, 0))
    expect(logger.error).toHaveBeenCalledWith(
      'Redis sticky bucket save failed',
      expect.objectContaining({
        key: 'avsb:sticky:user-1:flag-a',
        error: expect.stringContaining('connection refused'),
      }),
    )
  })

  it('catches and logs Redis errors on background fetch', async () => {
    const redis = createMockRedis()
    const logger = createMockLogger()
    redis.get = vi.fn().mockRejectedValue(new Error('timeout'))

    const svc = new RedisStickyBucketService({ redis, logger })

    expect(() => svc.lookup('user-1', 'flag-a')).not.toThrow()

    await new Promise((r) => setTimeout(r, 0))
    expect(logger.error).toHaveBeenCalledWith(
      'Redis sticky bucket fetch failed',
      expect.objectContaining({
        key: 'avsb:sticky:user-1:flag-a',
        error: expect.stringContaining('timeout'),
      }),
    )
  })
})
