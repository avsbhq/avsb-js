import { describe, expect, it, vi } from 'vitest';
import { checkExpectedType, createFlag, notFoundFlag, notReadyFlag } from '@avsbhq/core';
import type { EvalContext, Flag, FlagDatafileEntry, SingleContext } from '@avsbhq/core';
import { AvsbProvider, AvsbWebProvider, ofContextToEvalContext } from './openfeature';

// ---------------------------------------------------------------------------
// Test doubles that behave like the real SDKs where it matters.
//
// The type-mismatch fallback is the thing under test in half this file, so the
// fakes below do NOT hand-roll it: they call the REAL `checkExpectedType` from
// @avsbhq/core, exactly as `AvsbServer.evaluateAndBuild` and
// `AvsbClient.readTyped` do, and fall back through the REAL `notFoundFlag`. A
// fake that decided for itself what a mismatch looks like would only ever
// prove that the fake agrees with the test.
// ---------------------------------------------------------------------------

type FlagType = FlagDatafileEntry['type'];

interface FlagSpec {
  /** What the PLATFORM declares this flag to be. */
  type: FlagType;
  /** What it resolves to. Deliberately separable from `type`. */
  value: unknown;
}

function entryFor(key: string, spec: FlagSpec): FlagDatafileEntry {
  return {
    id: `flag_${key}`,
    key,
    type: spec.type,
    enabled: true,
    defaultVariationId: 'var_on',
    variations: [{ id: 'var_on', key: 'on', value: spec.value }],
    overrides: [],
    rules: [],
  };
}

/** One read, with the same shape as a served evaluation. */
function servedFlag<T>(value: unknown): Flag<T> {
  return createFlag<T>({
    value: value as T,
    variationKey: 'on',
    source: 'rule',
    ruleId: 'r1',
    ruleType: 'ab_test',
    reasons: [],
  });
}

/**
 * The generic read, then the real type check on top, mirroring the order the
 * SDKs use: evaluate first, then refuse a value whose type contradicts the
 * datafile.
 */
function readTyped<T>(
  flags: Record<string, FlagSpec>,
  flagKey: string,
  defaultValue: T,
  expected?: FlagType,
): Flag<T> {
  const spec = flags[flagKey];
  if (!spec) return notFoundFlag(defaultValue, `flag "${flagKey}" is not in the datafile`);

  const flag = servedFlag<T>(spec.value);
  if (!expected) return flag;

  const mismatch = checkExpectedType(entryFor(flagKey, spec), expected, spec.value);
  return mismatch ? notFoundFlag(defaultValue, mismatch) : flag;
}

function fakeServer(flags: Record<string, FlagSpec> = {}) {
  const seen: Array<{ flagKey: string; context?: EvalContext }> = [];
  const record = <T>(
    flagKey: string,
    defaultValue: T,
    context?: EvalContext,
    expected?: FlagType,
  ) => {
    seen.push({ flagKey, context });
    return readTyped(flags, flagKey, defaultValue, expected);
  };

  return {
    seen,
    track: vi.fn(),
    getFlag: (k: string, d: unknown, c?: EvalContext) => record(k, d, c),
    getBoolFlag: (k: string, d: boolean, c?: EvalContext) => record(k, d, c, 'boolean'),
    getStringFlag: (k: string, d: string, c?: EvalContext) => record(k, d, c, 'string'),
    getNumberFlag: (k: string, d: number, c?: EvalContext) => record(k, d, c, 'number'),
    getJsonFlag: (k: string, d: unknown, c?: EvalContext) => record(k, d, c, 'json'),
  };
}

/**
 * A browser-shaped client with a REAL bound identity: `identify` rebinds it
 * and reads answer per bound key, which is the only way a test can tell
 * whether `onContextChange` actually rebound anything.
 */
function fakeWebClient(byContextKey: Record<string, Record<string, FlagSpec>>) {
  let bound: EvalContext = { kind: 'user', key: 'anon' };
  const flagsForBound = (): Record<string, FlagSpec> =>
    byContextKey[(bound as SingleContext).key] ?? {};

  return {
    identify(context: EvalContext): void {
      bound = context;
    },
    boundContext: (): EvalContext => bound,
    track: vi.fn(),
    getFlag: (k: string, d: unknown) => readTyped(flagsForBound(), k, d),
    getBoolFlag: (k: string, d: boolean) => readTyped(flagsForBound(), k, d, 'boolean'),
    getStringFlag: (k: string, d: string) => readTyped(flagsForBound(), k, d, 'string'),
    getNumberFlag: (k: string, d: number) => readTyped(flagsForBound(), k, d, 'number'),
    getJsonFlag: (k: string, d: unknown) => readTyped(flagsForBound(), k, d, 'json'),
  };
}

describe('ofContextToEvalContext', () => {
  it('maps targetingKey onto key', () => {
    const ctx = ofContextToEvalContext({ targetingKey: 'u_1', plan: 'pro' });
    expect(ctx.key).toBe('u_1');
    expect((ctx as Record<string, unknown>).plan).toBe('pro');
  });

  it('falls back to a key attribute when no targetingKey', () => {
    expect(ofContextToEvalContext({ key: 'fallback' }).key).toBe('fallback');
  });

  it('produces an empty key when nothing identifies the subject', () => {
    expect(ofContextToEvalContext({}).key).toBe('');
  });
});

describe('AvsbProvider', () => {
  it('resolves booleans into ResolutionDetails<boolean>', () => {
    const p = new AvsbProvider(fakeServer({ flagA: { type: 'boolean', value: true } }));
    const res = p.resolveBooleanEvaluation('flagA', false, { targetingKey: 'u_1' });
    expect(res.value).toBe(true);
    expect(res.variant).toBe('on');
    expect(res.reason).toBe('RULE');
    expect(res.errorCode).toBeUndefined();
  });

  it('passes the evaluation context as the third POSITIONAL argument (B3)', () => {
    const server = fakeServer({ flagA: { type: 'boolean', value: true } });
    new AvsbProvider(server).resolveBooleanEvaluation('flagA', false, {
      targetingKey: 'u_1',
      plan: 'pro',
    });
    expect(server.seen).toEqual([
      { flagKey: 'flagA', context: { kind: 'user', key: 'u_1', plan: 'pro' } },
    ]);
  });

  it('handles object evaluations with typed defaults', () => {
    const p = new AvsbProvider(fakeServer({ flagA: { type: 'json', value: { tier: 3 } } }));
    const res = p.resolveObjectEvaluation('flagA', { tier: 1 }, { targetingKey: 'u' });
    expect(res.value).toEqual({ tier: 3 });
  });

  it('forwards track() to the server WITH the evaluation context attached', () => {
    const server = fakeServer();
    new AvsbProvider(server).track('signup', { targetingKey: 'u_1' }, { value: 1 });
    // The context is what the server attributes the event to; forwarding the
    // payload alone left the event with no visitor.
    expect(server.track).toHaveBeenCalledWith('signup', {
      value: 1,
      context: { kind: 'user', key: 'u_1' },
    });
  });

  it('still attaches a context when OpenFeature supplies no tracking details', () => {
    const server = fakeServer();
    new AvsbProvider(server).track('signup', { targetingKey: 'u_2' });
    expect(server.track).toHaveBeenCalledWith('signup', {
      context: { kind: 'user', key: 'u_2' },
    });
  });
});

describe('AvsbProvider — typed resolvers honour the declared flag type', () => {
  // The bug: every resolver called the GENERIC `getFlag`, which skips the
  // runtime type check, so `getBooleanValue()` on a JSON flag handed the
  // object back typed as a boolean.
  const MIXED = {
    jsonFlag: { type: 'json' as const, value: { tier: 3 } },
    boolFlag: { type: 'boolean' as const, value: true },
    stringFlag: { type: 'string' as const, value: 'B' },
    numberFlag: { type: 'number' as const, value: 42 },
  };

  it('falls back to the default when a boolean is asked of a JSON flag', () => {
    const p = new AvsbProvider(fakeServer(MIXED));
    const res = p.resolveBooleanEvaluation('jsonFlag', false, { targetingKey: 'u' });

    expect(res.value).toBe(false);
    expect(res.reason).toBe('ERROR');
    expect(res.errorCode).toBe('FLAG_NOT_FOUND');
    expect(res.errorMessage).toContain('declared as "json"');
  });

  it('falls back to the default when a string is asked of a number flag', () => {
    const p = new AvsbProvider(fakeServer(MIXED));
    const res = p.resolveStringEvaluation('numberFlag', 'fallback', { targetingKey: 'u' });

    expect(res.value).toBe('fallback');
    expect(res.reason).toBe('ERROR');
    expect(res.errorMessage).toContain('a "string" variant was requested');
  });

  it('falls back to the default when a number is asked of a boolean flag', () => {
    const p = new AvsbProvider(fakeServer(MIXED));
    const res = p.resolveNumberEvaluation('boolFlag', 7, { targetingKey: 'u' });

    expect(res.value).toBe(7);
    expect(res.reason).toBe('ERROR');
  });

  it('serves each type when the declaration and the request agree', () => {
    const p = new AvsbProvider(fakeServer(MIXED));
    const ctx = { targetingKey: 'u' };

    expect(p.resolveBooleanEvaluation('boolFlag', false, ctx).value).toBe(true);
    expect(p.resolveStringEvaluation('stringFlag', 'A', ctx).value).toBe('B');
    expect(p.resolveNumberEvaluation('numberFlag', 0, ctx).value).toBe(42);
    expect(p.resolveObjectEvaluation('jsonFlag', {}, ctx).value).toEqual({ tier: 3 });
  });

  it('reports a missing flag as an OpenFeature error, not as a served value', () => {
    const p = new AvsbProvider(fakeServer(MIXED));
    const res = p.resolveBooleanEvaluation('nope', true, { targetingKey: 'u' });

    expect(res.value).toBe(true);
    expect(res.reason).toBe('ERROR');
    expect(res.errorCode).toBe('FLAG_NOT_FOUND');
  });

  it('reports a not_ready read as PROVIDER_NOT_READY', () => {
    // Reading before the SDK has a datafile is a provider-state problem, and
    // OpenFeature has a code for exactly that. It used to surface as the
    // non-standard reason "NOT_READY" with no errorCode at all.
    const server = {
      ...fakeServer(),
      getBoolFlag: () => notReadyFlag<boolean>(false, 'SDK not ready'),
    };
    const res = new AvsbProvider(server).resolveBooleanEvaluation('flagA', false, {
      targetingKey: 'u',
    });

    expect(res.reason).toBe('ERROR');
    expect(res.errorCode).toBe('PROVIDER_NOT_READY');
    expect(res.errorMessage).toBe('SDK not ready');
  });
});

describe('AvsbWebProvider', () => {
  it('resolves strings via the bound client', () => {
    const client = fakeWebClient({ anon: { flagA: { type: 'string', value: 'B' } } });
    expect(new AvsbWebProvider(client).resolveStringEvaluation('flagA', 'A').value).toBe('B');
  });

  it('onContextChange rebinds identity, so later reads answer for the NEW subject', () => {
    // The regression this pins: `onContextChange` called `setContext?.()`, a
    // method no A vs B client has. Optional-call syntax made that compile and
    // do nothing, so OpenFeature's setContext() left every evaluation on the
    // old user. Asserting a spy was called would have passed then too; only a
    // CHANGE IN THE ANSWER proves the rebind happened.
    const client = fakeWebClient({
      anon: { theme: { type: 'string', value: 'control' } },
      u_1: { theme: { type: 'string', value: 'treatment' } },
    });
    const p = new AvsbWebProvider(client);

    expect(p.resolveStringEvaluation('theme', 'fallback').value).toBe('control');

    p.onContextChange({}, { targetingKey: 'u_1', plan: 'pro' });

    expect(p.resolveStringEvaluation('theme', 'fallback').value).toBe('treatment');
  });

  it('carries the full OpenFeature context, not just the targeting key', () => {
    const client = fakeWebClient({});
    new AvsbWebProvider(client).onContextChange({}, { targetingKey: 'u_1', plan: 'pro' });

    expect(client.boundContext()).toEqual({ kind: 'user', key: 'u_1', plan: 'pro' });
  });

  it('applies the type check on the browser side too', () => {
    const client = fakeWebClient({ anon: { jsonFlag: { type: 'json', value: { a: 1 } } } });
    const res = new AvsbWebProvider(client).resolveBooleanEvaluation('jsonFlag', false);

    expect(res.value).toBe(false);
    expect(res.reason).toBe('ERROR');
    expect(res.errorCode).toBe('FLAG_NOT_FOUND');
  });
});
