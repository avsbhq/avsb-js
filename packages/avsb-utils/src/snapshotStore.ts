// =====================================================================
// Snapshot bootstrap store: the read side of `applySnapshot`.
//
// WHAT A SNAPSHOT IS. `serializeBootstrap` on a server (or edge) client
// produces a `FlagSnapshot`: every flag's value for ONE context, already
// evaluated, plus the datafile version it was evaluated against. The blob
// travels in the SSR response. `hydrateBootstrap` hands it to the client.
//
// SEMANTICS OF ADOPTING ONE (the decision this module encodes):
//
//   1. Adopted snapshot values ANSWER READS until a real datafile exists on
//      the client. The moment one arrives (network, cache, or an explicit
//      `applyDatafile`), the store is released and local evaluation takes
//      over. A snapshot is a bridge across the first paint, never a
//      long-lived source of truth: it cannot answer a key the server did not
//      evaluate, and it cannot re-evaluate when the context changes.
//   2. PROVENANCE IS HONEST. The flag keeps the `source` the server recorded
//      (`rule`, `holdout`, `default`, ...) because that decision really was
//      made, and gains one extra reason string naming the snapshot and its
//      capture time. `flag.source` is never rewritten to hide the handoff,
//      and no new source member was invented for it.
//   3. READS ARE SIDE-EFFECT FREE. Serving a snapshot value fires no
//      exposure: the server either already recorded it or deliberately did
//      not. Double-counting one decision across two runtimes would corrupt
//      the results the customer acts on.
//   4. A KEY THE SNAPSHOT DOES NOT CARRY reads as a miss (`null` from
//      `read`), so the caller falls through to its own not-ready or
//      not-found path. The store never fabricates a value.
//
// Server clients deliberately do NOT adopt snapshots: one snapshot belongs
// to one context, while a server evaluates a different context per request,
// so seeding it process-wide would serve user A's values to user B. See the
// refusal path in `hydrateBootstrap`.
// =====================================================================

import type { Flag } from '@avsbhq/core'
import { createFlag } from '@avsbhq/core'
import type { FlagSnapshot } from './snapshots'

export interface SnapshotStore {
  /** Adopt a snapshot, replacing any previously adopted one. */
  adopt(snap: FlagSnapshot): void
  /** Drop the snapshot. Called when a real datafile becomes readable. */
  release(): void
  /** True while snapshot values are answering reads. */
  isActive(): boolean
  /** The adopted snapshot, or null. */
  current(): FlagSnapshot | null
  /**
   * One flag, re-stamped with snapshot provenance, or `null` when the
   * snapshot has no entry for this key (or nothing is adopted).
   */
  read<T>(flagKey: string, defaultValue: T): Flag<T> | null
  /** Every flag the snapshot carries, re-stamped. Empty when inactive. */
  readAll(): Record<string, Flag>
  /** Flag keys the snapshot carries. Empty when inactive. */
  keys(): string[]
}

/**
 * The reason string appended to every flag served from a snapshot. Exported
 * so a client's tests (and a docs example) can assert the provenance line
 * rather than duplicating the wording.
 */
export function snapshotReason(snap: FlagSnapshot): string {
  const contexts = snap.contextSummary
    .map((entry) => `${entry.kind}:${entry.key}`)
    .join(', ')
  return (
    `served from a server bootstrap snapshot captured at ` +
    `${new Date(snap.capturedAt).toISOString()}` +
    `${contexts ? ` for ${contexts}` : ''}` +
    `${snap.datafileVersion ? ` (datafile ${snap.datafileVersion})` : ''}`
  )
}

export function createSnapshotStore(): SnapshotStore {
  let snapshot: FlagSnapshot | null = null
  let reason = ''
  // Re-stamped flags are cached so repeated reads return the SAME object.
  // React's useSyncExternalStore compares snapshots by identity, so a fresh
  // object per read is an infinite render loop (the bug the snapshot cache
  // exists to prevent on the datafile path; the same rule applies here).
  let restamped = new Map<string, Flag<unknown>>()

  function adopt(snap: FlagSnapshot): void {
    snapshot = snap
    reason = snapshotReason(snap)
    restamped = new Map()
  }

  function release(): void {
    snapshot = null
    reason = ''
    restamped = new Map()
  }

  function isActive(): boolean {
    return snapshot !== null
  }

  function current(): FlagSnapshot | null {
    return snapshot
  }

  function stamp(flagKey: string, entry: Flag): Flag<unknown> {
    const hit = restamped.get(flagKey)
    if (hit) return hit

    const built = createFlag<unknown>({
      value: entry.value,
      variationKey: entry.variationKey,
      source: entry.source,
      ruleId: entry.ruleId,
      ruleType: entry.ruleType,
      reasons: [...(entry.reasons ?? []), reason],
      evaluatedAt: entry.evaluatedAt,
      durationMicros: entry.durationMicros,
    })
    restamped.set(flagKey, built)
    return built
  }

  function read<T>(flagKey: string, _defaultValue: T): Flag<T> | null {
    if (!snapshot) return null
    const entry = snapshot.flags[flagKey]
    if (!entry) return null
    // The cast is the one the whole bootstrap path rests on: the server
    // evaluated this key from the same flag registry the caller is typing
    // against, so the value already has the flag's declared type. A caller
    // that disagrees still has its own typed getter's runtime check.
    return stamp(flagKey, entry) as Flag<T>
  }

  function readAll(): Record<string, Flag> {
    if (!snapshot) return {}
    const out: Record<string, Flag> = {}
    for (const flagKey of Object.keys(snapshot.flags)) {
      const entry = snapshot.flags[flagKey]
      if (entry) out[flagKey] = stamp(flagKey, entry)
    }
    return out
  }

  function keys(): string[] {
    return snapshot ? Object.keys(snapshot.flags) : []
  }

  return { adopt, release, isActive, current, read, readAll, keys }
}
