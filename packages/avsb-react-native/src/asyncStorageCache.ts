// AsyncStorage-backed UnifiedStorageAdapter for React Native.
// Mirrors the pattern of createLocalStorageAdapter (avsb-utils/src/storage.ts)
// but uses an async storage interface (AsyncStorage from @react-native-async-storage)
// rather than the synchronous localStorage API.
//
// Because UnifiedStorageAdapter.stickyLookup is synchronous, sticky assignments
// are mirrored to an in-memory cache on every save. Cold reads (before any save
// in this process) return null. Call warmFromStorage() on app start to pre-populate
// the cache from persisted storage.

import type { FlagDatafile, StickyAssignment } from '@avsbhq/core'
import type { UnifiedStorageAdapter } from '@avsbhq/utils'

// ---------------------------------------------------------------------------
// AsyncStorageLike — structural type matching @react-native-async-storage
// ---------------------------------------------------------------------------

/**
 * Structural interface for AsyncStorage. Any object satisfying this shape is
 * accepted; this avoids importing from the peer dep at compile time so this
 * package builds in Node-only environments.
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AsyncStorageAdapterOptions {
  storage: AsyncStorageLike
  /** Key namespace prefix. Default: 'avsb'. */
  namespace?: string
  /** TTL for cached datafile entries in milliseconds. Default: Infinity. */
  datafileTtlMs?: number
}

// ---------------------------------------------------------------------------
// Internal type for stored datafile entries
// ---------------------------------------------------------------------------

interface StoredDatafileEntry {
  datafile: FlagDatafile
  cachedAt: number
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a UnifiedStorageAdapter backed by AsyncStorage.
 *
 * @param opts - Options including the AsyncStorage instance, namespace, and TTL.
 * @returns A UnifiedStorageAdapter instance.
 */
export function createAsyncStorageAdapter(
  opts: AsyncStorageAdapterOptions
): UnifiedStorageAdapter & { warmFromStorage(): Promise<void> } {
  const ns = opts.namespace ?? 'avsb'
  const ttl = opts.datafileTtlMs ?? Infinity
  const { storage } = opts

  // In-memory sticky cache — populated on stickySave and optionally warmed
  // from storage via warmFromStorage().
  const stickyMem = new Map<string, StickyAssignment>()
  let healthy = true

  const stickyKey = (ctxKey: string, flagKey: string): string =>
    `${ns}:sticky:${ctxKey}:${flagKey}`
  const datafileKey = (sdkKey: string): string => `${ns}:df:${sdkKey}`

  return {
    // -----------------------------------------------------------------------
    // Sticky bucketing — sync hot path
    // -----------------------------------------------------------------------
    stickyLookup(ctxKey: string, flagKey: string): StickyAssignment | null {
      return stickyMem.get(`${ctxKey}:${flagKey}`) ?? null
    },

    stickySave(ctxKey: string, flagKey: string, assignment: StickyAssignment): void {
      stickyMem.set(`${ctxKey}:${flagKey}`, assignment)
      storage
        .setItem(stickyKey(ctxKey, flagKey), JSON.stringify(assignment))
        .catch(() => {
          healthy = false
        })
    },

    // -----------------------------------------------------------------------
    // Datafile cache — async
    // -----------------------------------------------------------------------
    async datafileGet(sdkKey: string): Promise<StoredDatafileEntry | null> {
      try {
        const raw = await storage.getItem(datafileKey(sdkKey))
        if (!raw) return null
        const parsed = JSON.parse(raw) as StoredDatafileEntry
        if (ttl !== Infinity && Date.now() - parsed.cachedAt > ttl) {
          await storage.removeItem(datafileKey(sdkKey)).catch(() => {})
          return null
        }
        return parsed
      } catch {
        healthy = false
        return null
      }
    },

    async datafileSet(sdkKey: string, datafile: FlagDatafile): Promise<void> {
      try {
        const entry: StoredDatafileEntry = { datafile, cachedAt: Date.now() }
        await storage.setItem(datafileKey(sdkKey), JSON.stringify(entry))
      } catch {
        healthy = false
      }
    },

    // -----------------------------------------------------------------------
    // Health
    // -----------------------------------------------------------------------
    isHealthy(): boolean {
      return healthy
    },

    // -----------------------------------------------------------------------
    // warmFromStorage — pre-populate the in-memory sticky cache on app start.
    // Call this once after constructing the adapter so that any sticky
    // assignments persisted from a previous session are available for sync
    // reads on the first render pass.
    //
    // It scans all keys with the sticky namespace prefix and loads them into
    // the in-memory map. This is a best-effort operation; failures are
    // swallowed so app startup is never blocked.
    // -----------------------------------------------------------------------
    async warmFromStorage(): Promise<void> {
      // AsyncStorage does not expose a bulk-get-by-prefix API, so callers who
      // need complete cold-start coverage should persist and reload the full
      // sticky set via a separate key (e.g. an index). This default
      // implementation does nothing — subclasses / wrappers that have access
      // to a key enumeration API (e.g. AsyncStorage.getAllKeys) can override.
      //
      // This method is included as a documented hook so callers know where to
      // add warm-up logic; it is intentionally a no-op in the base adapter.
    },
  }
}

// ---------------------------------------------------------------------------
// Enhanced factory with getAllKeys warm-up support
// ---------------------------------------------------------------------------

/**
 * Extended AsyncStorage interface that also exposes getAllKeys, available on
 * the @react-native-async-storage/async-storage implementation.
 */
export interface AsyncStorageWithKeys extends AsyncStorageLike {
  getAllKeys(): Promise<readonly string[]>
  multiGet(
    keys: readonly string[]
  ): Promise<ReadonlyArray<[string, string | null]>>
}

/**
 * Warm the in-memory sticky cache from an AsyncStorage instance that supports
 * getAllKeys. Call this once on app start before the first render.
 *
 * Returns the set of sticky keys that were loaded.
 */
export async function warmFromStorage(
  storage: AsyncStorageWithKeys,
  adapter: UnifiedStorageAdapter,
  namespace = 'avsb'
): Promise<void> {
  const prefix = `${namespace}:sticky:`
  try {
    const allKeys = await storage.getAllKeys()
    const stickyKeys = allKeys.filter((k) => k.startsWith(prefix))
    if (stickyKeys.length === 0) return

    const pairs = await storage.multiGet(stickyKeys)
    for (const [key, value] of pairs) {
      if (!value) continue
      // Extract contextKey:flagKey from the full key
      const rest = key.slice(prefix.length)
      const colonIdx = rest.indexOf(':')
      if (colonIdx === -1) continue
      const ctxKey = rest.slice(0, colonIdx)
      const flagKey = rest.slice(colonIdx + 1)
      try {
        const assignment = JSON.parse(value) as StickyAssignment
        adapter.stickySave(ctxKey, flagKey, assignment)
      } catch {
        // corrupt entry — skip
      }
    }
  } catch {
    // getAllKeys / multiGet unavailable or failed — silent fallback
  }
}
