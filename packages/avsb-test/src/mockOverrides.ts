// =====================================================================
// Runtime overrides for `createMockClient`.
//
// The real browser client keeps this in `packages/avsb-browser/src/
// overrideStore.ts`, which is internal to that package (not exported), so
// the mock cannot import it. The PRECEDENCE RULE is mirrored here on
// purpose and is the thing that has to stay in step: a per-context entry
// beats a global one, and a variation key the fixture does not know is
// still honoured, with its own key becoming the value, so an override set
// before flags exist is not silently discarded.
//
// Everything else the real store does (reading variation values out of a
// datafile) has no equivalent here: a mock has a flags MAP, not a datafile.
// =====================================================================

import { bucketingKey, createFlag, isMultiContext } from '@avsbhq/core';
import type { EvalContext, Flag, SingleContext } from '@avsbhq/core';

interface OverrideEntry {
  global?: string;
  perContext: Map<string, string>;
}

export interface MockOverrideStore {
  setForContext(
    flagKey: string,
    contextKey: string,
    variationKey: string,
    contextKind: string,
  ): void;
  setGlobal(flagKey: string, variationKey: string): void;
  clearForContext(flagKey: string, contextKey: string, contextKind: string): void;
  clearGlobal(flagKey: string): void;
  clearAll(): void;
  /**
   * The overriding Flag, or null when no override applies to this flag for
   * this context. `knownValues` maps a variation key to the value the
   * fixture holds for it, when the test set one up.
   */
  resolve<T>(
    flagKey: string,
    ctx: EvalContext,
    knownValues?: Record<string, unknown>,
  ): Flag<T> | null;
  /** Flag keys that currently carry any override. */
  keys(): string[];
}

function storeKeyOf(contextKey: string, contextKind: string): string {
  return `${contextKind}::${contextKey}`;
}

/**
 * The key an override is matched against: the primary key of the context.
 * A multi-context is addressed by its `user` sub-context, matching
 * `primaryKeyOf` in the real browser client.
 */
export function overrideContextKeyOf(ctx: EvalContext): { key: string; kind: string } {
  if (isMultiContext(ctx)) {
    return { key: bucketingKey(ctx, 'user'), kind: 'user' };
  }
  const single = ctx as SingleContext;
  return { key: single.key, kind: single.kind };
}

export function createMockOverrideStore(): MockOverrideStore {
  const overrides = new Map<string, OverrideEntry>();

  function entryFor(flagKey: string): OverrideEntry {
    let entry = overrides.get(flagKey);
    if (!entry) {
      entry = { perContext: new Map() };
      overrides.set(flagKey, entry);
    }
    return entry;
  }

  return {
    setForContext(flagKey, contextKey, variationKey, contextKind) {
      entryFor(flagKey).perContext.set(storeKeyOf(contextKey, contextKind), variationKey);
    },

    setGlobal(flagKey, variationKey) {
      entryFor(flagKey).global = variationKey;
    },

    clearForContext(flagKey, contextKey, contextKind) {
      overrides.get(flagKey)?.perContext.delete(storeKeyOf(contextKey, contextKind));
    },

    clearGlobal(flagKey) {
      const entry = overrides.get(flagKey);
      if (entry) entry.global = undefined;
    },

    clearAll() {
      overrides.clear();
    },

    resolve<T>(
      flagKey: string,
      ctx: EvalContext,
      knownValues?: Record<string, unknown>,
    ): Flag<T> | null {
      const entry = overrides.get(flagKey);
      if (!entry) return null;

      const { key, kind } = overrideContextKeyOf(ctx);
      const variationKey = entry.perContext.get(storeKeyOf(key, kind)) ?? entry.global;
      if (!variationKey) return null;

      const known = knownValues && variationKey in knownValues;

      return createFlag<T>({
        value: known ? (knownValues[variationKey] as T) : (variationKey as unknown as T),
        variationKey,
        source: 'runtimeOverride',
        ruleId: null,
        ruleType: null,
        reasons: [`runtime override: variationKey=${variationKey}`],
      });
    },

    keys() {
      return [...overrides.keys()];
    },
  };
}
