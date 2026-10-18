// =====================================================================
// Referentially stable flag snapshots (WS2 item 2, report 02 §5.3 and
// §5.4, report 03 handoff item 1).
//
// THE BUG THIS EXISTS TO KILL: `getSnapshot` delegated straight to the
// evaluator, which built a fresh frozen `Flag` on every call, complete
// with a fresh `evaluatedAt` and `durationMicros`. React's
// `useSyncExternalStore` compares snapshots by identity, so every render
// saw a "new" value. React's own guard for that is the runtime error
// "The result of getSnapshot should be cached to avoid an infinite loop",
// and the seven framework adapters were all built on this method.
//
// The contract, which the adapters are entitled to rely on:
//
//   1. Two `getSnapshot(key, default)` calls with no intervening change
//      return the SAME object (===).
//   2. The cached object is dropped when, and only when, something that
//      could change that flag's value changes: a new datafile, a context
//      change, an override change, or the ready transition.
//   3. Reading a snapshot has NO side effects. No exposure, no evaluation
//      event, no cache rebuild. A render is not a decision.
//
// Cache keying. The entry key is (flagKey, variant, default), not just
// flagKey, because the default value is part of the answer: two
// components reading the same missing flag with different defaults must
// each get their own stable object, and a typed getter's runtime type
// check can turn the same key into a different result than the generic
// getter. Defaults are keyed by their JSON form so the common
// `getJsonFlag('k', { timeout: 5000 })` pattern (a fresh literal every
// render) still hits one entry; defaults that will not serialise fall
// back to identity keying through a WeakMap.
// =====================================================================

import type { Flag } from '@avsbhq/core'

/**
 * Which getter produced the entry. Typed getters apply a runtime type
 * check that can substitute the default, so they cannot share the generic
 * getter's entry for the same key.
 */
export type SnapshotVariant = 'any' | 'boolean' | 'string' | 'number' | 'json'

/**
 * Upper bound on entries. Reached only by pathological keying (a default
 * that serialises differently on every render); the cache is cleared
 * rather than allowed to grow without limit in a long-lived SPA.
 */
const MAX_ENTRIES = 500

/**
 * Entry-key delimiter. Written as an escape rather than a literal control
 * character: a raw NUL byte makes git treat this file as binary, which
 * would hide every future diff of the module that defines the snapshot
 * contract. Same runtime string either way.
 */
const SEPARATOR = '\u0000'

export interface SnapshotCache {
  /**
   * Return the cached Flag for this (key, variant, default), computing and
   * storing it on a miss.
   */
  get<T>(
    flagKey: string,
    variant: SnapshotVariant,
    defaultValue: unknown,
    compute: () => Flag<T>,
  ): Flag<T>
  /** Drop every entry for one flag key. */
  invalidateKey(flagKey: string): void
  /** Drop everything. Used whenever the datafile or context changes. */
  clear(): void
  /** Entry count. Exposed for tests and diagnostics. */
  size(): number
}

/**
 * Stable string for a default value.
 *
 * JSON first (so structurally equal literals collapse to one entry), then
 * identity for anything JSON cannot express (a default carrying a
 * function, a cyclic object, a BigInt). Identity keying is what keeps the
 * React contract intact for those callers: a component that passes the
 * same object every render still gets one entry, and one that passes a
 * fresh unserialisable object every render gets fresh entries, which the
 * MAX_ENTRIES guard bounds.
 */
function createDefaultKeyer(): (value: unknown) => string {
  const identities = new WeakMap<object, string>()
  let counter = 0

  return function keyOf(value: unknown): string {
    if (value === undefined) return 'u'
    if (value === null) return 'n'
    const primitive = typeof value
    if (primitive !== 'object' && primitive !== 'function') {
      try {
        return `p:${JSON.stringify(value)}`
      } catch {
        return `p:${String(value)}`
      }
    }

    const asObject = value as object
    const existing = identities.get(asObject)
    if (existing) return existing

    let key: string
    try {
      key = `o:${JSON.stringify(value)}`
    } catch {
      counter += 1
      key = `i:${counter}`
    }
    identities.set(asObject, key)
    return key
  }
}

export function createSnapshotCache(): SnapshotCache {
  // flagKey -> entryKey -> Flag. Two levels so per-key invalidation does
  // not have to scan the whole cache on every datafile poll.
  const byFlagKey = new Map<string, Map<string, Flag<unknown>>>()
  const keyOfDefault = createDefaultKeyer()
  let entries = 0

  function get<T>(
    flagKey: string,
    variant: SnapshotVariant,
    defaultValue: unknown,
    compute: () => Flag<T>,
  ): Flag<T> {
    const entryKey = `${variant}${SEPARATOR}${keyOfDefault(defaultValue)}`
    const hit = byFlagKey.get(flagKey)?.get(entryKey)
    // The cast is safe by construction: an entry is only ever written by a
    // call carrying the same flagKey, variant, and default, and those three
    // determine T.
    if (hit) return hit as Flag<T>

    const computed = compute()

    // Bound the cache before inserting. Clearing (rather than evicting one
    // entry) keeps this O(1) and self-healing: the next render repopulates
    // only what is actually being read.
    if (entries >= MAX_ENTRIES) clear()

    let bucket = byFlagKey.get(flagKey)
    if (!bucket) {
      bucket = new Map<string, Flag<unknown>>()
      byFlagKey.set(flagKey, bucket)
    }
    bucket.set(entryKey, computed as Flag<unknown>)
    entries += 1
    return computed
  }

  function invalidateKey(flagKey: string): void {
    const bucket = byFlagKey.get(flagKey)
    if (!bucket) return
    entries -= bucket.size
    if (entries < 0) entries = 0
    byFlagKey.delete(flagKey)
  }

  function clear(): void {
    byFlagKey.clear()
    entries = 0
  }

  function size(): number {
    return entries
  }

  return { get, invalidateKey, clear, size }
}
