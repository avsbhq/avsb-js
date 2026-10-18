// UnifiedStorageAdapter — one connector handles BOTH sticky bucketing AND
// datafile caching. Simpler than maintaining two parallel interfaces.
// Spec §6.7.

import type { FlagDatafile, StickyAssignment } from '@avsbhq/core'

export interface UnifiedStorageAdapter {
  // Sticky bucket — sync hot-path
  stickyLookup(contextKey: string, flagKey: string): StickyAssignment | null
  stickySave(
    contextKey: string,
    flagKey: string,
    assignment: StickyAssignment
  ): void

  // Datafile cache — async OK
  datafileGet(
    sdkKey: string
  ): Promise<{ datafile: FlagDatafile; cachedAt: number } | null>
  datafileSet(sdkKey: string, datafile: FlagDatafile): Promise<void>

  // Adapter health
  isHealthy(): boolean
}

export interface CookieJar {
  get(key: string): string | null
  set(key: string, value: string, opts: CookieOpts): void
}

export interface CookieOpts {
  maxAge?: number
  path?: string
  domain?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
}

// ---------------------------------------------------------------------------
// In-memory adapter — single-process safe.
// ---------------------------------------------------------------------------

export function createMemoryAdapter(opts?: {
  datafileTtlMs?: number
}): UnifiedStorageAdapter {
  const sticky = new Map<string, StickyAssignment>()
  const datafile = new Map<
    string,
    { datafile: FlagDatafile; cachedAt: number }
  >()
  const ttl = opts?.datafileTtlMs ?? Infinity
  return {
    stickyLookup: (ctxKey, flagKey) => sticky.get(`${ctxKey}:${flagKey}`) ?? null,
    stickySave: (ctxKey, flagKey, a) => {
      sticky.set(`${ctxKey}:${flagKey}`, a)
    },
    async datafileGet(sdkKey) {
      const e = datafile.get(sdkKey)
      if (!e) return null
      if (Date.now() - e.cachedAt > ttl) {
        datafile.delete(sdkKey)
        return null
      }
      return e
    },
    async datafileSet(sdkKey, df) {
      datafile.set(sdkKey, { datafile: df, cachedAt: Date.now() })
    },
    isHealthy: () => true,
  }
}

// ---------------------------------------------------------------------------
// Redis adapter — production sticky + datafile cache backed by Redis.
// ---------------------------------------------------------------------------

export interface RedisLike {
  get(key: string): Promise<string | null>
  set(
    key: string,
    value: string,
    opts?: { ex?: number; px?: number }
  ): Promise<unknown>
  del?(key: string): Promise<unknown>
}

export function createRedisAdapter(opts: {
  client: RedisLike
  prefix?: string
  datafileTtlMs?: number
  /**
   * Sticky lookups are sync per the interface; this adapter pre-warms a
   * local LRU on save and returns from it. Pure cold reads return null, so
   * callers should pre-warm via `warmSticky(contextKey)` before hot reads.
   */
}): UnifiedStorageAdapter {
  const prefix = opts.prefix ?? 'avsb'
  const ttlSeconds = opts.datafileTtlMs
    ? Math.max(1, Math.floor(opts.datafileTtlMs / 1000))
    : undefined
  const stickyCache = new Map<string, StickyAssignment>()
  let healthy = true

  const k = (parts: string[]): string => `${prefix}:${parts.join(':')}`

  return {
    stickyLookup: (ctxKey, flagKey) =>
      stickyCache.get(`${ctxKey}:${flagKey}`) ?? null,
    stickySave(ctxKey, flagKey, assignment) {
      stickyCache.set(`${ctxKey}:${flagKey}`, assignment)
      opts.client
        .set(k(['sticky', ctxKey, flagKey]), JSON.stringify(assignment))
        .catch(() => {
          healthy = false
        })
    },
    async datafileGet(sdkKey) {
      try {
        const raw = await opts.client.get(k(['df', sdkKey]))
        if (!raw) return null
        const parsed = JSON.parse(raw) as {
          datafile: FlagDatafile
          cachedAt: number
        }
        return parsed
      } catch {
        healthy = false
        return null
      }
    },
    async datafileSet(sdkKey, df) {
      try {
        const blob = JSON.stringify({ datafile: df, cachedAt: Date.now() })
        await opts.client.set(
          k(['df', sdkKey]),
          blob,
          ttlSeconds ? { ex: ttlSeconds } : undefined
        )
      } catch {
        healthy = false
      }
    },
    isHealthy: () => healthy,
  }
}

// ---------------------------------------------------------------------------
// Cookie adapter (browser).
// ---------------------------------------------------------------------------

export function createCookieAdapter(opts: {
  cookies: CookieJar
  namespace?: string
}): UnifiedStorageAdapter {
  const ns = opts.namespace ?? 'avsb'
  const stickyMem = new Map<string, StickyAssignment>()
  return {
    stickyLookup(ctxKey, flagKey) {
      const inMem = stickyMem.get(`${ctxKey}:${flagKey}`)
      if (inMem) return inMem
      const raw = opts.cookies.get(`${ns}:sticky:${ctxKey}:${flagKey}`)
      if (!raw) return null
      try {
        const a = JSON.parse(raw) as StickyAssignment
        stickyMem.set(`${ctxKey}:${flagKey}`, a)
        return a
      } catch {
        return null
      }
    },
    stickySave(ctxKey, flagKey, a) {
      stickyMem.set(`${ctxKey}:${flagKey}`, a)
      opts.cookies.set(
        `${ns}:sticky:${ctxKey}:${flagKey}`,
        JSON.stringify(a),
        { maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' }
      )
    },
    async datafileGet(sdkKey) {
      const raw = opts.cookies.get(`${ns}:df:${sdkKey}`)
      if (!raw) return null
      try {
        return JSON.parse(raw) as {
          datafile: FlagDatafile
          cachedAt: number
        }
      } catch {
        return null
      }
    },
    async datafileSet(sdkKey, df) {
      const blob = JSON.stringify({ datafile: df, cachedAt: Date.now() })
      opts.cookies.set(`${ns}:df:${sdkKey}`, blob, { maxAge: 60 * 60 })
    },
    isHealthy: () => true,
  }
}

// ---------------------------------------------------------------------------
// localStorage adapter (browser).
// ---------------------------------------------------------------------------

export function createLocalStorageAdapter(opts?: {
  namespace?: string
}): UnifiedStorageAdapter {
  const ns = opts?.namespace ?? 'avsb'
  const ls = (
    globalThis as { localStorage?: Storage }
  ).localStorage
  const stickyMem = new Map<string, StickyAssignment>()
  if (!ls) return createMemoryAdapter()
  return {
    stickyLookup(ctxKey, flagKey) {
      const inMem = stickyMem.get(`${ctxKey}:${flagKey}`)
      if (inMem) return inMem
      try {
        const raw = ls.getItem(`${ns}:sticky:${ctxKey}:${flagKey}`)
        if (!raw) return null
        const a = JSON.parse(raw) as StickyAssignment
        stickyMem.set(`${ctxKey}:${flagKey}`, a)
        return a
      } catch {
        return null
      }
    },
    stickySave(ctxKey, flagKey, a) {
      stickyMem.set(`${ctxKey}:${flagKey}`, a)
      try {
        ls.setItem(`${ns}:sticky:${ctxKey}:${flagKey}`, JSON.stringify(a))
      } catch {
        /* quota errors: fall back to memory only */
      }
    },
    async datafileGet(sdkKey) {
      try {
        const raw = ls.getItem(`${ns}:df:${sdkKey}`)
        if (!raw) return null
        return JSON.parse(raw) as {
          datafile: FlagDatafile
          cachedAt: number
        }
      } catch {
        return null
      }
    },
    async datafileSet(sdkKey, df) {
      try {
        ls.setItem(
          `${ns}:df:${sdkKey}`,
          JSON.stringify({ datafile: df, cachedAt: Date.now() })
        )
      } catch {
        /* quota */
      }
    },
    isHealthy: () => true,
  }
}

// ---------------------------------------------------------------------------
// IndexedDB adapter (browser).
// ---------------------------------------------------------------------------

export function createIndexedDBAdapter(opts?: {
  dbName?: string
}): UnifiedStorageAdapter {
  const dbName = opts?.dbName ?? 'avsb'
  const stickyMem = new Map<string, StickyAssignment>()
  // Sticky reads are sync per the interface — the IDB adapter mirrors writes
  // into the in-memory cache and only persists asynchronously. Datafile
  // reads are async (interface permits).
  const writeIdb = (
    store: 'sticky' | 'datafile',
    key: string,
    value: unknown
  ): void => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    if (!idb) return
    try {
      const req = idb.open(dbName, 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('sticky')) db.createObjectStore('sticky')
        if (!db.objectStoreNames.contains('datafile')) db.createObjectStore('datafile')
      }
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(store, 'readwrite')
        tx.objectStore(store).put(value, key)
      }
    } catch {
      /* best-effort */
    }
  }
  const readIdb = async (
    store: 'sticky' | 'datafile',
    key: string
  ): Promise<unknown> => {
    const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB
    if (!idb) return null
    return new Promise((resolve) => {
      try {
        const req = idb.open(dbName, 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('sticky')) db.createObjectStore('sticky')
          if (!db.objectStoreNames.contains('datafile')) db.createObjectStore('datafile')
        }
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(store, 'readonly')
          const get = tx.objectStore(store).get(key)
          get.onsuccess = () => resolve(get.result ?? null)
          get.onerror = () => resolve(null)
        }
        req.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return {
    stickyLookup: (ctxKey, flagKey) =>
      stickyMem.get(`${ctxKey}:${flagKey}`) ?? null,
    stickySave(ctxKey, flagKey, a) {
      stickyMem.set(`${ctxKey}:${flagKey}`, a)
      writeIdb('sticky', `${ctxKey}:${flagKey}`, a)
    },
    async datafileGet(sdkKey) {
      const raw = await readIdb('datafile', sdkKey)
      if (!raw) return null
      return raw as { datafile: FlagDatafile; cachedAt: number }
    },
    async datafileSet(sdkKey, df) {
      writeIdb('datafile', sdkKey, { datafile: df, cachedAt: Date.now() })
    },
    isHealthy: () =>
      typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined',
  }
}

// ---------------------------------------------------------------------------
// DynamoDB adapter (server).
// ---------------------------------------------------------------------------

export interface DynamoDBClientLike {
  getItem(opts: {
    TableName: string
    Key: Record<string, { S: string }>
  }): Promise<{ Item?: Record<string, { S?: string }> }>
  putItem(opts: {
    TableName: string
    Item: Record<string, { S: string }>
  }): Promise<unknown>
}

export function createDynamoDBAdapter(opts: {
  client: DynamoDBClientLike
  tableName: string
}): UnifiedStorageAdapter {
  const stickyMem = new Map<string, StickyAssignment>()
  let healthy = true
  return {
    stickyLookup: (ctxKey, flagKey) =>
      stickyMem.get(`${ctxKey}:${flagKey}`) ?? null,
    stickySave(ctxKey, flagKey, a) {
      stickyMem.set(`${ctxKey}:${flagKey}`, a)
      opts.client
        .putItem({
          TableName: opts.tableName,
          Item: {
            pk: { S: `sticky:${ctxKey}:${flagKey}` },
            data: { S: JSON.stringify(a) },
          },
        })
        .catch(() => {
          healthy = false
        })
    },
    async datafileGet(sdkKey) {
      try {
        const res = await opts.client.getItem({
          TableName: opts.tableName,
          Key: { pk: { S: `df:${sdkKey}` } },
        })
        const raw = res.Item?.data?.S
        if (!raw) return null
        return JSON.parse(raw) as {
          datafile: FlagDatafile
          cachedAt: number
        }
      } catch {
        healthy = false
        return null
      }
    },
    async datafileSet(sdkKey, df) {
      try {
        await opts.client.putItem({
          TableName: opts.tableName,
          Item: {
            pk: { S: `df:${sdkKey}` },
            data: {
              S: JSON.stringify({ datafile: df, cachedAt: Date.now() }),
            },
          },
        })
      } catch {
        healthy = false
      }
    },
    isHealthy: () => healthy,
  }
}

// ---------------------------------------------------------------------------
// Postgres adapter (server).
// ---------------------------------------------------------------------------

export interface PgClientLike {
  query(opts: {
    text: string
    values: unknown[]
  }): Promise<{ rows: Array<{ data: string }> }>
}

export function createPostgresAdapter(opts: {
  client: PgClientLike
  tableName?: string
}): UnifiedStorageAdapter {
  const table = opts.tableName ?? 'avsb_storage'
  const stickyMem = new Map<string, StickyAssignment>()
  let healthy = true
  return {
    stickyLookup: (ctxKey, flagKey) =>
      stickyMem.get(`${ctxKey}:${flagKey}`) ?? null,
    stickySave(ctxKey, flagKey, a) {
      stickyMem.set(`${ctxKey}:${flagKey}`, a)
      opts.client
        .query({
          text: `INSERT INTO ${table}(pk, data) VALUES($1, $2) ON CONFLICT (pk) DO UPDATE SET data = EXCLUDED.data`,
          values: [`sticky:${ctxKey}:${flagKey}`, JSON.stringify(a)],
        })
        .catch(() => {
          healthy = false
        })
    },
    async datafileGet(sdkKey) {
      try {
        const res = await opts.client.query({
          text: `SELECT data FROM ${table} WHERE pk = $1`,
          values: [`df:${sdkKey}`],
        })
        const raw = res.rows[0]?.data
        if (!raw) return null
        return JSON.parse(raw) as {
          datafile: FlagDatafile
          cachedAt: number
        }
      } catch {
        healthy = false
        return null
      }
    },
    async datafileSet(sdkKey, df) {
      try {
        await opts.client.query({
          text: `INSERT INTO ${table}(pk, data) VALUES($1, $2) ON CONFLICT (pk) DO UPDATE SET data = EXCLUDED.data`,
          values: [
            `df:${sdkKey}`,
            JSON.stringify({ datafile: df, cachedAt: Date.now() }),
          ],
        })
      } catch {
        healthy = false
      }
    },
    isHealthy: () => healthy,
  }
}

// ---------------------------------------------------------------------------
// Durable Object adapter (Cloudflare Workers).
// ---------------------------------------------------------------------------

export interface DurableObjectStubLike {
  fetch(
    input: string | URL,
    init?: { method?: string; body?: string }
  ): Promise<Response>
}

export function createDurableObjectAdapter(opts: {
  stub: DurableObjectStubLike
}): UnifiedStorageAdapter {
  const stickyMem = new Map<string, StickyAssignment>()
  let healthy = true
  // RFC 2606 .invalid TLD — Durable Object fetch handler ignores hostname.
  const base = 'https://do.invalid'
  return {
    stickyLookup: (ctxKey, flagKey) =>
      stickyMem.get(`${ctxKey}:${flagKey}`) ?? null,
    stickySave(ctxKey, flagKey, a) {
      stickyMem.set(`${ctxKey}:${flagKey}`, a)
      opts.stub
        .fetch(`${base}/sticky/${ctxKey}/${flagKey}`, {
          method: 'PUT',
          body: JSON.stringify(a),
        })
        .catch(() => {
          healthy = false
        })
    },
    async datafileGet(sdkKey) {
      try {
        const res = await opts.stub.fetch(`${base}/df/${sdkKey}`)
        if (!res.ok) return null
        return (await res.json()) as {
          datafile: FlagDatafile
          cachedAt: number
        }
      } catch {
        healthy = false
        return null
      }
    },
    async datafileSet(sdkKey, df) {
      try {
        await opts.stub.fetch(`${base}/df/${sdkKey}`, {
          method: 'PUT',
          body: JSON.stringify({ datafile: df, cachedAt: Date.now() }),
        })
      } catch {
        healthy = false
      }
    },
    isHealthy: () => healthy,
  }
}
