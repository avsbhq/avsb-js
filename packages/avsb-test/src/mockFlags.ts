// =====================================================================
// The bridge between `TestData` and the mock clients, and the flag-resolution
// both mocks share.
//
// THE BUG THIS CLOSES (report 02 §5.18): four READMEs taught
// `createMockClient({ flags: [td.build()] })`. `flags` is a
// `Record<flagKey, value>` map, so an ARRAY of TestData entries did not
// typecheck, and at runtime every flag fell through to its default. The
// advertised test story was a dead end, and `TestData` was consumed by nothing
// outside its own unit test.
//
// `flagsFromTestData(entries)` produces exactly the option shape the mocks
// take, so the builder and the mocks finally meet:
//
//   const client = createMockClient(flagsFromTestData([td.build()]))
// =====================================================================

import type { EvalContext } from '@avsbhq/core'
import { bucketingKey } from '@avsbhq/core'
import type { TestDataEntry } from './TestData'

/** The option slice both mock factories accept. */
export interface MockFlagState {
  /** flagKey to value. The value every context gets unless overridden. */
  flags: Record<string, unknown>
  /** `${flagKey}:${contextKey}` to value. Beats `flags`. */
  flagsByUser: Record<string, unknown>
}

/**
 * Convert built `TestData` entries into `createMockClient` /
 * `createMockServer` options.
 *
 * - `fallthroughVariation(value)` becomes the entry in `flags`.
 * - `variationForUser(userKey, value)` becomes an entry in `flagsByUser`.
 * - `variationForContext(kind, key, value)` also becomes an entry in
 *   `flagsByUser`, keyed by the context KEY. The mocks match on the bound
 *   context's key and do not compare kinds, so a per-organization override
 *   applies whenever the bound context carries that key.
 */
export function flagsFromTestData(
  entries: readonly TestDataEntry[]
): MockFlagState {
  const flags: Record<string, unknown> = {}
  const flagsByUser: Record<string, unknown> = {}

  for (const entry of entries) {
    flags[entry.key] = entry.fallthroughValue

    const valueOf = (variationId: string): unknown =>
      entry.variations.find((variation) => variation.id === variationId)?.value

    for (const override of entry.overrides) {
      flagsByUser[`${entry.key}:${override.userId}`] = valueOf(override.variationId)
    }
    for (const override of entry.contextOverrides) {
      flagsByUser[`${entry.key}:${override.key}`] = valueOf(override.variationId)
    }
  }

  return { flags, flagsByUser }
}

/** One resolved read: the value, and whether the mock knew the key at all. */
export interface ResolvedMockValue {
  value: unknown
  found: boolean
}

export interface MockFlagResolver {
  /** The bucketing key of a context, the way both mocks read identity. */
  keyOf(context: EvalContext): string
  resolve<T>(flagKey: string, defaultValue: T, context: EvalContext): ResolvedMockValue
  /** Every flag key the mock can answer for this context. */
  keysFor(context: EvalContext): string[]
  set(flagKey: string, value: unknown): void
}

/**
 * Shared resolution so the browser-shaped mock and the server-shaped mock
 * cannot drift into answering the same fixture differently.
 */
export function createMockFlagResolver(state: MockFlagState): MockFlagResolver {
  const flags = { ...state.flags }
  const flagsByUser = { ...state.flagsByUser }

  function keyOf(context: EvalContext): string {
    return bucketingKey(context, context.kind === 'multi' ? 'user' : context.kind)
  }

  return {
    keyOf,

    resolve<T>(flagKey: string, defaultValue: T, context: EvalContext): ResolvedMockValue {
      const perUser = `${flagKey}:${keyOf(context)}`
      if (perUser in flagsByUser) return { value: flagsByUser[perUser], found: true }
      if (flagKey in flags) return { value: flags[flagKey], found: true }
      return { value: defaultValue, found: false }
    },

    keysFor(context: EvalContext): string[] {
      const contextKey = keyOf(context)
      const keys = new Set(Object.keys(flags))
      for (const composite of Object.keys(flagsByUser)) {
        const separator = composite.lastIndexOf(':')
        if (separator === -1) continue
        if (composite.slice(separator + 1) === contextKey) {
          keys.add(composite.slice(0, separator))
        }
      }
      return [...keys]
    },

    set(flagKey: string, value: unknown): void {
      flags[flagKey] = value
    },
  }
}
