import { describe, it, expect } from 'vitest';
// The engine subpath, because that is where the evaluator lives. These
// assertions run the built datafile through the REAL evaluator instead of
// re-reading the object this builder just wrote.
import { evaluateFlag } from '@avsbhq/core/engine';
import type { EvalContext, FlagDatafileEntry } from '@avsbhq/core';
import { createTestDatafile, TEST_SDK_KEY } from './datafile';

const CTX: EvalContext = { kind: 'user', key: 'test-user' };

describe('createTestDatafile — defaults', () => {
  it('returns a valid version-2 datafile', () => {
    const df = createTestDatafile();
    expect(df.version).toBe(2);
    expect(df.projectType).toBe('FEATURE_FLAG');
  });

  it('populates required fields with defaults when nothing is passed', () => {
    const df = createTestDatafile();
    // A real-SHAPED key, so a fixture cannot make an SDK's key-shape check
    // fire in a test that is about something else.
    expect(df.sdkKey).toBe(TEST_SDK_KEY);
    expect(df.environmentKey).toBe('test');
    expect(df.publishedAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('publishes collectEndpoint as an unreachable origin, not a path', () => {
    // SDKs append `/v1/collect/*` themselves through the core endpoint
    // contract; a fixture ending in a path produced doubled URLs. `.invalid`
    // never resolves, so a stray flush cannot reach a real host.
    const df = createTestDatafile();
    expect(df.collectEndpoint).toBe('https://collect.test.invalid');
    expect(df.collectEndpoint.endsWith('/')).toBe(false);
  });

  it('starts with empty flags and audiences', () => {
    const df = createTestDatafile();
    expect(df.flags).toHaveLength(0);
    expect(df.audiences).toHaveLength(0);
  });
});

describe('createTestDatafile — the flags map', () => {
  it('turns each entry into one flag serving that value', () => {
    const df = createTestDatafile({ 'checkout-v2': true, 'cta-copy': 'Buy now' });
    expect(df.flags.map((f) => f.key)).toEqual(['checkout-v2', 'cta-copy']);
    expect(df.flags[0].variations[0].value).toBe(true);
    expect(df.flags[1].variations[0].value).toBe('Buy now');
  });

  it('derives the flag type from the value', () => {
    const df = createTestDatafile({
      bool: true,
      str: 'x',
      num: 3,
      obj: { a: 1 },
      nul: null,
    });
    expect(df.flags.map((f) => f.type)).toEqual(['boolean', 'string', 'number', 'json', 'json']);
  });

  it('serves the value through a 100% ab_test rule, so reads report source rule', () => {
    // The point of the rule: `source: 'rule'` is what fires an exposure. A
    // builder that used defaultVariationId alone would report 'default' and
    // every exposure assertion written against it would pass for the wrong
    // reason.
    const df = createTestDatafile({ 'checkout-v2': true });
    const details = evaluateFlag('checkout-v2', false, CTX, df);
    expect(details.value).toBe(true);
    expect(details.source).toBe('rule');
    expect(details.ruleType).toBe('ab_test');
  });

  it('fires an exposure, because the value is served by a rule', () => {
    const df = createTestDatafile({ 'checkout-v2': true });
    const exposures: string[] = [];
    evaluateFlag('checkout-v2', false, CTX, df, (e) => exposures.push(e.variationId));
    expect(exposures).toHaveLength(1);
  });

  it('evaluates the same value for a different context key', () => {
    const df = createTestDatafile({ 'checkout-v2': true });
    const other: EvalContext = { kind: 'user', key: 'someone-else-entirely' };
    expect(evaluateFlag('checkout-v2', false, other, df).value).toBe(true);
  });

  it('gives every flag its own variation and rule ids', () => {
    const df = createTestDatafile({ a: true, b: false });
    const ids = df.flags.flatMap((f) => [f.id, f.rules[0].id, f.variations[0].id]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('createTestDatafile — options', () => {
  it('accepts a custom sdkKey and environmentKey', () => {
    const df = createTestDatafile(
      {},
      { sdkKey: 'sdk_staging_abcdefgh', environmentKey: 'staging' },
    );
    expect(df.sdkKey).toBe('sdk_staging_abcdefgh');
    expect(df.environmentKey).toBe('staging');
  });

  it('accepts a later publishedAt, which is how a republish is simulated', () => {
    const df = createTestDatafile({ a: true }, { publishedAt: '2026-06-01T00:00:00.000Z' });
    expect(df.publishedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('appends hand-built entries after the mapped ones', () => {
    const entry: FlagDatafileEntry = {
      id: 'flag-hand',
      key: 'hand-built',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var-off',
      variations: [
        { id: 'var-on', key: 'on', value: true },
        { id: 'var-off', key: 'off', value: false },
      ],
      overrides: [],
      rules: [],
    };
    const df = createTestDatafile({ mapped: true }, { entries: [entry] });
    expect(df.flags.map((f) => f.key)).toEqual(['mapped', 'hand-built']);
  });

  it('serves a hand-built entry through its own default variation', () => {
    const entry: FlagDatafileEntry = {
      id: 'flag-hand',
      key: 'hand-built',
      type: 'string',
      enabled: true,
      defaultVariationId: 'var-quiet',
      variations: [{ id: 'var-quiet', key: 'quiet', value: 'shh' }],
      overrides: [],
      rules: [],
    };
    const df = createTestDatafile({}, { entries: [entry] });
    const details = evaluateFlag('hand-built', 'fallback', CTX, df);
    expect(details.value).toBe('shh');
    expect(details.source).toBe('default');
  });
});

describe('createTestDatafile — optional v2 fields', () => {
  it('includes empty holdouts and bandits arrays', () => {
    const df = createTestDatafile();
    expect(df.holdouts).toEqual([]);
    expect(df.bandits).toEqual([]);
  });

  it('includes contextKinds with at least user', () => {
    const df = createTestDatafile();
    expect(df.contextKinds).toContain('user');
  });

  it('exposes exposureSampling of 1, so every read is recorded', () => {
    const df = createTestDatafile();
    expect(df.exposureSampling).toBe(1);
  });
});
