// Runtime override storage for AvsbServer, extracted so the class keeps to
// lifecycle and evaluation. Pure map bookkeeping, no datafile access: the
// caller resolves a variation key to a variation.

/** Overrides for one flag key. */
interface FlagOverrides {
  /** Variation key applied to every context. */
  global?: string
  /** `${kind}:${key}` → variation key. */
  perKindKey: Map<string, string>
}

export interface OverrideStore {
  /**
   * Variation key to force for this flag and context key, or undefined.
   * A per-context override wins over a global one.
   */
  resolve(flagKey: string, contextKey: string, contextKind?: string): string | undefined
  setForContext(
    flagKey: string,
    contextKey: string,
    variationKey: string,
    contextKind?: string
  ): void
  setGlobal(flagKey: string, variationKey: string): void
  clearForContext(flagKey: string, contextKey: string, contextKind?: string): void
  clearGlobal(flagKey: string): void
  clearAll(): void
  /** Number of flags carrying at least one override. Diagnostics and tests. */
  size(): number
}

export function createOverrideStore(): OverrideStore {
  const byFlagKey = new Map<string, FlagOverrides>()

  function ensure(flagKey: string): FlagOverrides {
    const existing = byFlagKey.get(flagKey)
    if (existing) return existing
    const created: FlagOverrides = { perKindKey: new Map() }
    byFlagKey.set(flagKey, created)
    return created
  }

  function prune(flagKey: string, entry: FlagOverrides): void {
    if (!entry.global && entry.perKindKey.size === 0) byFlagKey.delete(flagKey)
  }

  return {
    resolve(flagKey, contextKey, contextKind = 'user') {
      const entry = byFlagKey.get(flagKey)
      if (!entry) return undefined
      return entry.perKindKey.get(`${contextKind}:${contextKey}`) ?? entry.global
    },

    setForContext(flagKey, contextKey, variationKey, contextKind = 'user') {
      ensure(flagKey).perKindKey.set(`${contextKind}:${contextKey}`, variationKey)
    },

    setGlobal(flagKey, variationKey) {
      ensure(flagKey).global = variationKey
    },

    clearForContext(flagKey, contextKey, contextKind = 'user') {
      const entry = byFlagKey.get(flagKey)
      if (!entry) return
      entry.perKindKey.delete(`${contextKind}:${contextKey}`)
      prune(flagKey, entry)
    },

    clearGlobal(flagKey) {
      const entry = byFlagKey.get(flagKey)
      if (!entry) return
      entry.global = undefined
      prune(flagKey, entry)
    },

    clearAll() {
      byFlagKey.clear()
    },

    size() {
      return byFlagKey.size
    },
  }
}
