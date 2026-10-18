// =====================================================================
// Runtime override storage (§5.9), extracted from AvsbClient so the
// client file stays close to its documented responsibilities.
//
// Behaviour is unchanged from the in-class version: a per-context entry
// wins over a global one, and a variation key that the datafile does not
// know is still honoured (its own key becomes the value) so an override
// set before the datafile arrives is not silently discarded.
// =====================================================================

import { createFlag, findDatafileFlag, isMultiContext } from '@avsbhq/core'
import type { EvalContext, Flag, FlagDatafile, SingleContext } from '@avsbhq/core'
import { primaryKeyOf } from './identity'

interface OverrideEntry {
  global?: string
  perContext: Map<string, string>
}

export interface OverrideStore {
  setForContext(
    flagKey: string,
    contextKey: string,
    variationKey: string,
    contextKind: string,
  ): void
  setGlobal(flagKey: string, variationKey: string): void
  clearForContext(flagKey: string, contextKey: string, contextKind: string): void
  clearGlobal(flagKey: string): void
  clearAll(): void
  /** Null when no override applies to this flag for this context. */
  resolve<T>(
    flagKey: string,
    ctx: EvalContext,
    datafile: FlagDatafile | null,
  ): Flag<T> | null
  /** Flag keys that currently carry any override. */
  keys(): string[]
}

function storeKeyOf(contextKey: string, contextKind: string): string {
  return `${contextKind}::${contextKey}`
}

export function createOverrideStore(): OverrideStore {
  const overrides = new Map<string, OverrideEntry>()

  function entryFor(flagKey: string): OverrideEntry {
    let entry = overrides.get(flagKey)
    if (!entry) {
      entry = { perContext: new Map() }
      overrides.set(flagKey, entry)
    }
    return entry
  }

  return {
    setForContext(flagKey, contextKey, variationKey, contextKind) {
      entryFor(flagKey).perContext.set(storeKeyOf(contextKey, contextKind), variationKey)
    },

    setGlobal(flagKey, variationKey) {
      entryFor(flagKey).global = variationKey
    },

    clearForContext(flagKey, contextKey, contextKind) {
      overrides.get(flagKey)?.perContext.delete(storeKeyOf(contextKey, contextKind))
    },

    clearGlobal(flagKey) {
      const entry = overrides.get(flagKey)
      if (entry) entry.global = undefined
    },

    clearAll() {
      overrides.clear()
    },

    resolve<T>(
      flagKey: string,
      ctx: EvalContext,
      datafile: FlagDatafile | null,
    ): Flag<T> | null {
      const entry = overrides.get(flagKey)
      if (!entry) return null

      const currentKind = isMultiContext(ctx) ? 'user' : (ctx as SingleContext).kind
      const variationKey =
        entry.perContext.get(storeKeyOf(primaryKeyOf(ctx), currentKind)) ?? entry.global
      if (!variationKey) return null

      const dfEntry = findDatafileFlag(datafile, flagKey)
      const variation = dfEntry?.variations.find((v) => v.key === variationKey)

      return createFlag<T>({
        value: (variation?.value as T) ?? (variationKey as unknown as T),
        variationKey,
        source: 'runtimeOverride',
        ruleId: null,
        ruleType: null,
        reasons: [`runtime override: variationKey=${variationKey}`],
      })
    },

    keys() {
      return [...overrides.keys()]
    },
  }
}
