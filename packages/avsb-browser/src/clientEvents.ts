// Change detection and notification for AvsbClient: the value cache, the
// per-flag subscriptions, the `evaluation` event and the init settle. Split
// out of AvsbClient.ts (FU-31).

import type { AvsbFlagKey, EvalContext, Flag, InitResult } from '@avsbhq/core'
import type { AvsbUtils } from '@avsbhq/utils'
import { contextSummary, mapLegacySource, toLegacyEvalContext } from '@avsbhq/core'
import { evaluateFlag } from '@avsbhq/core/engine'
import { buildBrowserUtils } from './utils'
import type { ClientState, FlagCacheEntry } from './clientState'
import type { AvsbClient } from './AvsbClient'

/**
 * The §6 `client.utils.*` surface, wired to one client. Built lazily by the
 * `utils` getter on first access. Every method goes back through the
 * client's own public methods, as it always has.
 */
export function buildClientUtils(client: AvsbClient, s: ClientState): AvsbUtils {
  return buildBrowserUtils({
    getFlag: <T,>(flagKey: AvsbFlagKey, defaultValue: T) =>
      client.getFlag<T>(flagKey, defaultValue),
    getAllFlags: (opts?: { fireExposures?: boolean; context?: EvalContext }) =>
      client.getAllFlags(opts),
    track: (eventKey, payload) => client.track(eventKey, payload),
    on: (event, cb) => client.on(event, cb),
    getContext: () => s.context,
    getDatafile: () => s.datafile,
    refreshDatafile: () => client.refresh(),
    applyDatafileBootstrap: (df) => client.applyDatafileBootstrap(df),
    applySnapshot: (snap) => client.applySnapshot(snap),
  })
}

/**
 * Everything about an evaluation that a cached snapshot exposes, collapsed
 * into one comparable string. Reasons are left out on purpose: they are
 * diagnostic prose, and rebuilding every snapshot because a reason string
 * was reworded would defeat the cache.
 */
function signatureOf(
  value: unknown,
  variationKey: string | null,
  source: string,
  ruleId: string | null,
): string {
  let serialisedValue: string
  try {
    serialisedValue = JSON.stringify(value) ?? 'undefined'
  } catch {
    serialisedValue = String(value)
  }
  return `${source}|${variationKey ?? ''}|${ruleId ?? ''}|${serialisedValue}`
}

/** Value-cache entry for an already-built Flag (the override path). */
function entryFromFlag(flag: Flag<unknown>): FlagCacheEntry {
  return {
    value: flag.value,
    signature: signatureOf(flag.value, flag.variationKey, flag.source, flag.ruleId),
  }
}

export function subscribeToFlag(
  s: ClientState,
  flagKey: string,
  listener: () => void,
): () => void {
  let listeners = s.flagSubscribers.get(flagKey)
  if (!listeners) {
    listeners = new Set()
    s.flagSubscribers.set(flagKey, listeners)
  }
  listeners.add(listener)
  return () => {
    const current = s.flagSubscribers.get(flagKey)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) s.flagSubscribers.delete(flagKey)
  }
}

/**
 * §2.14 `evaluation` — one event per single-flag evaluation.
 *
 * `contextKeys` carries the identity keys of the bound context (one per
 * context kind under multi-context), never attribute values: a subscriber
 * learns WHICH identity was evaluated without the SDK spraying potentially
 * private attributes onto a customer-supplied callback.
 *
 * Bulk `getAllFlags` deliberately does not emit here: one call would fire an
 * event per flag in the project, which is the same reason its exposures are
 * opt-in.
 */
export function emitEvaluation(s: ClientState, flagKey: string, flag: Flag<unknown>): void {
  s.bus.emit('evaluation', {
    flagKey,
    flag,
    contextKeys: contextSummary(s.context).map((entry) => entry.key),
  })
}

/**
 * Record the init outcome, resolve `onReady()`, and emit 'ready'.
 *
 * Called once per attempt, and once more if a LATER refresh rescues a
 * failed init (a wrong key that got fixed by a republish, a browser that
 * came back online). In that case `getInitResult()` starts telling the
 * truth and 'ready' fires, but the promise returned by `onReady()` keeps
 * the first answer: a promise settles once, and callers who need the live
 * state read `isReady()`.
 */
export function settleInit(s: ClientState, result: InitResult): void {
  const previous = s.initResult
  if (previous && (previous.success || !result.success)) return

  s.initResult = result
  if (s.readyResolve) {
    s.readyResolve(result)
    s.readyResolve = null
  }
  // `ready` means "the SDK can answer with real values". A failed init
  // says so through the 'error' event, not by claiming readiness.
  if (result.success) s.bus.emit('ready', result)
}

/** Evaluate every flag into the value cache. Pure: returns, never assigns. */
function buildFlagCache(s: ClientState): Record<string, FlagCacheEntry> {
  if (!s.datafile) return {}
  const next: Record<string, FlagCacheEntry> = {}
  const legacyCtx = toLegacyEvalContext(s.context)

  for (const entry of s.datafile.flags) {
    const override = s.overrides.resolve(entry.key, s.context, s.datafile)
    if (override) {
      next[entry.key] = entryFromFlag(override)
      continue
    }
    const evaluation = evaluateFlag(entry.key, undefined, legacyCtx, s.datafile)
    next[entry.key] = {
      value: evaluation.value,
      signature: signatureOf(
        evaluation.value,
        evaluation.variationKey,
        mapLegacySource(evaluation.source),
        evaluation.ruleId,
      ),
    }
  }

  // Overridden keys the datafile does not carry (a QA override typed for a
  // flag that has not shipped yet, or one set before a republish removed the
  // flag). `getFlag` answers these from the override store, so leaving them
  // out of the cache meant the answer changed while nothing invalidated the
  // snapshot and no subscriber fired: `getSnapshot` kept serving the stale
  // `not_found` object forever.
  //
  // A store entry whose per-context and global slots are both empty resolves
  // to null and drops out here, which is what makes clearing an override
  // register as a change too.
  for (const flagKey of s.overrides.keys()) {
    if (flagKey in next) continue
    const override = s.overrides.resolve(flagKey, s.context, s.datafile)
    if (override) next[flagKey] = entryFromFlag(override)
  }

  return next
}

/**
 * Rebuild the value cache, then tell everyone what moved.
 *
 * This is the single invalidation point for the snapshot cache: every
 * change that can alter a flag (datafile, context, override) comes through
 * here. Invalidation is PER KEY, so a datafile publish that moves one flag
 * leaves every other flag's snapshot object identical, which is what keeps
 * an unrelated component from re-rendering.
 */
export function diffAndEmitChanges(s: ClientState, options?: { notifyAllSubscribers?: boolean }): void {
  const oldCache = s.flagCache
  const next = buildFlagCache(s)
  s.flagCache = next
  s.allFlagsSnapshot = null

  const valueChanged: string[] = []
  const keys = new Set([...Object.keys(oldCache), ...Object.keys(next)])
  for (const key of keys) {
    const before = oldCache[key]
    const after = next[key]
    if (before?.signature !== after?.signature) s.snapshots.invalidateKey(key)
    if (JSON.stringify(before?.value) !== JSON.stringify(after?.value)) {
      valueChanged.push(key)
    }
  }

  for (const key of valueChanged) {
    s.bus.emit('flagChange', {
      flagKey: key,
      previousValue: oldCache[key]?.value,
      newValue: next[key]?.value,
    })
  }

  if (options?.notifyAllSubscribers) {
    // The ready transition. Every cached snapshot is stale (they all read
    // `not_ready`), including snapshots for keys the datafile does not
    // carry, whose answer moves from `not_ready` to `not_found`.
    s.snapshots.clear()
    for (const key of s.flagSubscribers.keys()) notifySubscribers(s, key)
    return
  }
  for (const key of valueChanged) notifySubscribers(s, key)
}

export function notifySubscribers(s: ClientState, flagKey: string): void {
  const subscribers = s.flagSubscribers.get(flagKey)
  if (!subscribers) return
  for (const listener of subscribers) {
    try {
      listener()
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      s.logger.warn('flag subscriber threw', {
        flagKey,
        error: err.message,
      })
    }
  }
}
