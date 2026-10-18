import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createAsyncStorageAdapter,
  warmFromStorage,
  type AsyncStorageLike,
  type AsyncStorageWithKeys,
} from './asyncStorageCache'

// ---------------------------------------------------------------------------
// Mock AsyncStorage factory — returns an in-memory implementation that
// records calls so we can assert on them.
// ---------------------------------------------------------------------------

function makeMockStorage(): AsyncStorageLike & {
  store: Map<string, string>
  failNext: boolean
} {
  const store = new Map<string, string>()
  let failNext = false
  return {
    store,
    get failNext() {
      return failNext
    },
    set failNext(v: boolean) {
      failNext = v
    },
    async getItem(key: string): Promise<string | null> {
      if (failNext) throw new Error('storage unavailable')
      return store.get(key) ?? null
    },
    async setItem(key: string, value: string): Promise<void> {
      if (failNext) throw new Error('storage unavailable')
      store.set(key, value)
    },
    async removeItem(key: string): Promise<void> {
      if (failNext) throw new Error('storage unavailable')
      store.delete(key)
    },
  }
}

// ---------------------------------------------------------------------------
// Tests: sticky bucketing
// ---------------------------------------------------------------------------

describe('createAsyncStorageAdapter — sticky bucketing', () => {
  it('returns null on a cold lookup before any save', () => {
    const storage = makeMockStorage()
    const adapter = createAsyncStorageAdapter({ storage })

    const result = adapter.stickyLookup('user-1', 'flag-a')

    expect(result).toBeNull()
  })

  it('round-trips a sticky assignment: save then lookup returns the same value', () => {
    const storage = makeMockStorage()
    const adapter = createAsyncStorageAdapter({ storage })
    const assignment = {
      variationId: 'var-1',
      ruleId: 'rule-1',
      ruleType: 'ab_test' as const,
      assignedAt: Date.now(),
    }

    adapter.stickySave('user-1', 'flag-a', assignment)
    const result = adapter.stickyLookup('user-1', 'flag-a')

    expect(result).toEqual(assignment)
  })

  it('does not confuse assignments for different context/flag pairs', () => {
    const storage = makeMockStorage()
    const adapter = createAsyncStorageAdapter({ storage })
    const assignmentA = {
      variationId: 'var-on',
      ruleId: 'rule-1',
      ruleType: 'ab_test' as const,
      assignedAt: 1000,
    }
    const assignmentB = {
      variationId: 'var-off',
      ruleId: 'rule-2',
      ruleType: 'targeted_delivery' as const,
      assignedAt: 2000,
    }

    adapter.stickySave('user-1', 'flag-a', assignmentA)
    adapter.stickySave('user-1', 'flag-b', assignmentB)

    expect(adapter.stickyLookup('user-1', 'flag-a')).toEqual(assignmentA)
    expect(adapter.stickyLookup('user-1', 'flag-b')).toEqual(assignmentB)
    expect(adapter.stickyLookup('user-2', 'flag-a')).toBeNull()
  })

  it('persists the assignment to AsyncStorage asynchronously', async () => {
    const storage = makeMockStorage()
    const adapter = createAsyncStorageAdapter({ storage, namespace: 'test' })
    const assignment = {
      variationId: 'var-treat',
      ruleId: 'rule-3',
      ruleType: 'ab_test' as const,
      assignedAt: 3000,
    }

    adapter.stickySave('ctx-1', 'my-flag', assignment)

    // Flush microtasks so the fire-and-forget setItem resolves
    await Promise.resolve()

    const storedRaw = storage.store.get('test:sticky:ctx-1:my-flag')
    expect(storedRaw).toBeDefined()
    expect(JSON.parse(storedRaw!)).toEqual(assignment)
  })
})

// ---------------------------------------------------------------------------
// Tests: datafile cache
// ---------------------------------------------------------------------------

describe('createAsyncStorageAdapter — datafile cache', () => {
  it('returns null for a key that has never been set', async () => {
    const storage = makeMockStorage()
    const adapter = createAsyncStorageAdapter({ storage })

    const result = await adapter.datafileGet('sdk-key-1')

    expect(result).toBeNull()
  })

  it('round-trips a datafile: set then get returns the same datafile', async () => {
    const storage = makeMockStorage()
    const adapter = createAsyncStorageAdapter({ storage })
    const datafile = {
      version: 1,
      flags: [],
      schemaVersion: '1.0',
      createdAt: 0,
      updatedAt: 0,
      segments: [],
      audiences: [],
    } as unknown as import('@avsbhq/core').FlagDatafile

    await adapter.datafileSet('sdk-key-1', datafile)
    const result = await adapter.datafileGet('sdk-key-1')

    expect(result).not.toBeNull()
    expect(result!.datafile).toEqual(datafile)
    expect(typeof result!.cachedAt).toBe('number')
  })

  it('returns null and removes the entry when the datafile TTL has expired', async () => {
    vi.useFakeTimers()
    const storage = makeMockStorage()
    const adapter = createAsyncStorageAdapter({ storage, datafileTtlMs: 1000 })
    const datafile = {
      version: 1,
      flags: [],
      schemaVersion: '1.0',
      createdAt: 0,
      updatedAt: 0,
      segments: [],
      audiences: [],
    } as unknown as import('@avsbhq/core').FlagDatafile

    await adapter.datafileSet('sdk-key-ttl', datafile)

    // Advance past the TTL
    vi.advanceTimersByTime(2000)

    const result = await adapter.datafileGet('sdk-key-ttl')
    expect(result).toBeNull()

    vi.useRealTimers()
  })

  it('does NOT expire a datafile before its TTL has elapsed', async () => {
    vi.useFakeTimers()
    const storage = makeMockStorage()
    const adapter = createAsyncStorageAdapter({ storage, datafileTtlMs: 5000 })
    const datafile = {
      version: 1,
      flags: [],
      schemaVersion: '1.0',
      createdAt: 0,
      updatedAt: 0,
      segments: [],
      audiences: [],
    } as unknown as import('@avsbhq/core').FlagDatafile

    await adapter.datafileSet('sdk-key-no-expire', datafile)

    vi.advanceTimersByTime(3000) // still within TTL

    const result = await adapter.datafileGet('sdk-key-no-expire')
    expect(result).not.toBeNull()

    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// Tests: isHealthy
// ---------------------------------------------------------------------------

describe('createAsyncStorageAdapter — isHealthy', () => {
  it('returns true initially with a working storage implementation', () => {
    const storage = makeMockStorage()
    const adapter = createAsyncStorageAdapter({ storage })

    expect(adapter.isHealthy()).toBe(true)
  })

  it('returns false after a datafileSet failure', async () => {
    const storage = makeMockStorage()
    const adapter = createAsyncStorageAdapter({ storage })

    storage.failNext = true
    await adapter.datafileSet(
      'sdk-err',
      {} as unknown as import('@avsbhq/core').FlagDatafile
    )

    expect(adapter.isHealthy()).toBe(false)
  })

  it('returns false after a datafileGet failure', async () => {
    const storage = makeMockStorage()
    const adapter = createAsyncStorageAdapter({ storage })

    // Manually corrupt the stored value so JSON.parse throws
    storage.store.set('avsb:df:bad-key', 'not-json{{{')

    await adapter.datafileGet('bad-key')

    expect(adapter.isHealthy()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: warmFromStorage
// ---------------------------------------------------------------------------

describe('warmFromStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function makeStorageWithKeys(
    entries: Record<string, string>
  ): AsyncStorageWithKeys {
    const store = new Map(Object.entries(entries))
    return {
      async getItem(key: string) {
        return store.get(key) ?? null
      },
      async setItem(key: string, value: string) {
        store.set(key, value)
      },
      async removeItem(key: string) {
        store.delete(key)
      },
      async getAllKeys() {
        return Array.from(store.keys())
      },
      async multiGet(keys: readonly string[]) {
        return keys.map((k) => [k, store.get(k) ?? null] as [string, string | null])
      },
    }
  }

  it('loads sticky entries from storage into the adapter memory', async () => {
    const assignment = {
      variationId: 'var-warm',
      ruleId: 'rule-warm',
      ruleType: 'ab_test' as const,
      assignedAt: 9000,
    }
    const storage = makeStorageWithKeys({
      'avsb:sticky:user-warm:flag-warm': JSON.stringify(assignment),
      'avsb:df:some-sdk-key': JSON.stringify({ datafile: {}, cachedAt: 0 }),
    })
    const adapter = createAsyncStorageAdapter({ storage })

    // Before warm, lookup returns null
    expect(adapter.stickyLookup('user-warm', 'flag-warm')).toBeNull()

    await warmFromStorage(storage, adapter)

    // After warm, lookup returns the persisted assignment
    expect(adapter.stickyLookup('user-warm', 'flag-warm')).toEqual(assignment)
  })

  it('handles an empty storage without throwing', async () => {
    const storage = makeStorageWithKeys({})
    const adapter = createAsyncStorageAdapter({ storage })

    await expect(warmFromStorage(storage, adapter)).resolves.toBeUndefined()
  })

  it('skips corrupt JSON entries without throwing', async () => {
    const storage = makeStorageWithKeys({
      'avsb:sticky:user-bad:flag-bad': 'not-valid-json{{{',
    })
    const adapter = createAsyncStorageAdapter({ storage })

    await expect(warmFromStorage(storage, adapter)).resolves.toBeUndefined()
    expect(adapter.stickyLookup('user-bad', 'flag-bad')).toBeNull()
  })
})
