// =====================================================================
// The read path shared by every getter on `createMockClient`.
//
// Extracted so the precedence rule (override, then per-user value, then
// the flags map, then not_found) is one function with one set of tests
// rather than something re-derived inside five typed getters, and so
// `createMockClient.ts` stays inside the file-size rule.
//
// It mirrors `AvsbClient.readFlag` / `computeFlag` in @avsbhq/browser:
//   - a not-ready read returns `not_ready`, never `not_found`, and records
//     nothing (B15: "you asked too early" and "that flag does not exist"
//     are different problems with different fixes);
//   - a render-safe read (`readOnly`, `getSnapshot`) records nothing,
//     because a render is a read, not a decision.
// =====================================================================

import { bucketingKey, createFlag, notFoundFlag, notReadyFlag } from '@avsbhq/core';
import type { EvalContext, EventBus, Flag } from '@avsbhq/core';
import type { MockOverrideStore } from './mockOverrides';

export interface EvaluationRecord {
  flagKey: string;
  value: unknown;
  contextKey: string;
}

export interface MockEvaluatorDeps {
  /** flagKey to value, shared by reference with the client so `_setFlag` is visible here. */
  flags: Record<string, unknown>;
  /** `${flagKey}:${contextKey}` to value. Beats `flags`. */
  flagsByUser: Record<string, unknown>;
  overrides: MockOverrideStore;
  bus: EventBus;
  /** Appended to on every recorded read; the client returns a copy of it. */
  evaluations: EvaluationRecord[];
  isReady: () => boolean;
}

export interface MockEvaluator {
  /** The key a read is attributed to: the primary key of the context. */
  contextKeyOf(ctx: EvalContext): string;
  evalFlag<T>(flagKey: string, defaultValue: T, ctx: EvalContext, record: boolean): Flag<T>;
}

function contextKeyOf(ctx: EvalContext): string {
  return bucketingKey(ctx, ctx.kind === 'multi' ? 'user' : ctx.kind);
}

/** The Flag a mock serves for a value it holds: rule-served, like production. */
function ruleFlag<T>(value: unknown): Flag<T> {
  return createFlag<T>({
    value: value as T,
    variationKey: 'mock-variation',
    source: 'rule',
    ruleId: 'mock',
    ruleType: 'ab_test',
    reasons: [],
  });
}

export function createMockEvaluator(deps: MockEvaluatorDeps): MockEvaluator {
  function emitEvaluation(flagKey: string, value: unknown, ctx: EvalContext): void {
    const contextKey = contextKeyOf(ctx);
    deps.evaluations.push({ flagKey, value, contextKey });
    deps.bus.emit('evaluation', {
      flagKey,
      flag: ruleFlag(value),
      contextKeys: [contextKey],
    });
  }

  function resolveValue<T>(
    flagKey: string,
    defaultValue: T,
    ctx: EvalContext,
  ): { value: unknown; found: boolean } {
    const perUserKey = `${flagKey}:${contextKeyOf(ctx)}`;
    if (perUserKey in deps.flagsByUser) {
      return { value: deps.flagsByUser[perUserKey], found: true };
    }
    if (flagKey in deps.flags) {
      return { value: deps.flags[flagKey], found: true };
    }
    return { value: defaultValue, found: false };
  }

  return {
    contextKeyOf,

    evalFlag<T>(flagKey: string, defaultValue: T, ctx: EvalContext, record: boolean): Flag<T> {
      if (!deps.isReady()) {
        return notReadyFlag(defaultValue, 'mock client not ready');
      }

      const overridden = deps.overrides.resolve<T>(flagKey, ctx, deps.flags);
      if (overridden) {
        if (record) emitEvaluation(flagKey, overridden.value, ctx);
        return overridden;
      }

      const { value, found } = resolveValue(flagKey, defaultValue, ctx);

      if (!found) {
        if (record) emitEvaluation(flagKey, defaultValue, ctx);
        return notFoundFlag(defaultValue, 'no mock flag');
      }

      if (record) emitEvaluation(flagKey, value, ctx);
      return ruleFlag<T>(value);
    },
  };
}
