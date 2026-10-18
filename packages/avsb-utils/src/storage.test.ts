import { describe, expect, it, vi } from 'vitest'
import type { FlagDatafile, StickyAssignment } from '@avsbhq/core'
import {
  createCookieAdapter,
  createDynamoDBAdapter,
  createMemoryAdapter,
  createPostgresAdapter,
  createRedisAdapter,
} from './storage'

const assignment: StickyAssignment = {
  variationId: 'v1',
  ruleId: 'r1',
  ruleType: 'ab_test',
  assignedAt: 1700000000000,
}

const datafile: FlagDatafile = {
  version: 2,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk',
  environmentKey: 'prod',
  publishedAt: '2026-05-28T00:00:00Z',
  collectEndpoint: 'https://collect',
  flags: [],
  audiences: [],
}

describe('createMemoryAdapter', () => {
  it('round-trips sticky assignments', () => {
    const a = createMemoryAdapter()
    a.stickySave('u_1', 'flagA', assignment)
    expect(a.stickyLookup('u_1', 'flagA')).toEqual(assignment)
    expect(a.stickyLookup('u_1', 'flagB')).toBeNull()
  })

  it('round-trips datafile cache entries', async () => {
    const a = createMemoryAdapter()
    await a.datafileSet('sdk', datafile)
    const got = await a.datafileGet('sdk')
    expect(got?.datafile).toBe(datafile)
  })

  it('expires datafile cache after TTL', async () => {
    const a = createMemoryAdapter({ datafileTtlMs: 1 })
    await a.datafileSet('sdk', datafile)
    await new Promise((r) => setTimeout(r, 5))
    expect(await a.datafileGet('sdk')).toBeNull()
  })

  it('reports healthy', () => {
    expect(createMemoryAdapter().isHealthy()).toBe(true)
  })
})

describe('createRedisAdapter', () => {
  it('persists sticky writes via the redis client (fire-and-forget)', async () => {
    const client = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => 'OK'),
    }
    const a = createRedisAdapter({ client })
    a.stickySave('u_1', 'flagA', assignment)
    expect(a.stickyLookup('u_1', 'flagA')).toEqual(assignment) // cache primed
    await new Promise((r) => setImmediate(r))
    expect(client.set).toHaveBeenCalled()
  })

  it('writes datafile with TTL when configured', async () => {
    const client = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => 'OK'),
    }
    const a = createRedisAdapter({ client, datafileTtlMs: 60_000 })
    await a.datafileSet('sdk', datafile)
    expect(client.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ ex: 60 })
    )
  })

  it('flips unhealthy when the underlying redis throws', async () => {
    const client = {
      get: vi.fn(async () => {
        throw new Error('disconnected')
      }),
      set: vi.fn(async () => 'OK'),
    }
    const a = createRedisAdapter({ client })
    await a.datafileGet('sdk')
    expect(a.isHealthy()).toBe(false)
  })
})

describe('createCookieAdapter', () => {
  it('round-trips sticky via cookies', () => {
    const store = new Map<string, string>()
    const a = createCookieAdapter({
      cookies: {
        get: (k) => store.get(k) ?? null,
        set: (k, v) => {
          store.set(k, v)
        },
      },
    })
    a.stickySave('u_1', 'flagA', assignment)
    expect(a.stickyLookup('u_1', 'flagA')).toEqual(assignment)
  })

  it('returns null for unknown sticky keys', () => {
    const a = createCookieAdapter({
      cookies: { get: () => null, set: () => undefined },
    })
    expect(a.stickyLookup('u_1', 'flagA')).toBeNull()
  })
})

describe('createDynamoDBAdapter', () => {
  it('writes sticky via putItem fire-and-forget', async () => {
    const client = {
      getItem: vi.fn(async () => ({})),
      putItem: vi.fn(async () => undefined),
    }
    const a = createDynamoDBAdapter({ client, tableName: 't' })
    a.stickySave('u_1', 'flagA', assignment)
    await new Promise((r) => setImmediate(r))
    expect(client.putItem).toHaveBeenCalled()
  })

  it('returns null when datafile missing', async () => {
    const client = {
      getItem: vi.fn(async () => ({})),
      putItem: vi.fn(async () => undefined),
    }
    const a = createDynamoDBAdapter({ client, tableName: 't' })
    expect(await a.datafileGet('sdk')).toBeNull()
  })
})

describe('createPostgresAdapter', () => {
  it('upserts sticky on save', async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [] })),
    }
    const a = createPostgresAdapter({ client })
    a.stickySave('u_1', 'flagA', assignment)
    await new Promise((r) => setImmediate(r))
    expect(client.query).toHaveBeenCalled()
  })

  it('returns parsed datafile from the cache row', async () => {
    const client = {
      query: vi.fn(async () => ({
        rows: [
          {
            data: JSON.stringify({ datafile, cachedAt: 100 }),
          },
        ],
      })),
    }
    const a = createPostgresAdapter({ client })
    const got = await a.datafileGet('sdk')
    expect(got?.datafile.sdkKey).toBe('sdk')
  })
})
