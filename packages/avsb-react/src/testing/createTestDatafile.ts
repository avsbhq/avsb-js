// =====================================================================
// A real datafile from a plain flags map.
//
// The testing story used to be fiction: `AvsbTestProvider` provided its
// own private context, so the real hooks threw underneath it, and every
// documented example named props that did not exist (report 03 §6).
//
// This builds the thing the SDK actually eats: a `FlagDatafile` whose
// flags evaluate to the values you asked for, for every visitor. The test
// provider then runs the REAL client and the REAL provider on it, so a
// test exercises the same code path production does, including the store
// contract, the type checks, and `isEnabled()`.
// =====================================================================

import type { FlagDatafile, FlagDatafileEntry } from '@avsbhq/core';

/** What a flag can be set to in a test. */
export type TestFlagValue = boolean | string | number | object | null;

/** Flag key to value. `{ 'checkout-v2': true }`. */
export type TestFlags = Record<string, TestFlagValue>;

export interface CreateTestDatafileOptions {
  /** SDK key written into the datafile. Default 'sdk_test_000000000000'. */
  sdkKey?: string;
  /** Environment key written into the datafile. Default 'test'. */
  environmentKey?: string;
}

function typeOf(value: TestFlagValue): FlagDatafileEntry['type'] {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  return 'json';
}

/**
 * Build a `FlagDatafile` in which every flag serves the value you gave it.
 *
 * ```ts
 * const datafile: FlagDatafile = createTestDatafile({
 *   'checkout-v2': true,
 *   'cta-copy': 'Buy now',
 * })
 * ```
 *
 * Each flag gets one variation, keyed `test`, used as the flag's default
 * variation, so every context evaluates to it with `source: 'default'`.
 * Use `<AvsbTestProvider flags={...}>` unless you need the datafile
 * itself.
 */
export function createTestDatafile(
  flags: TestFlags,
  options?: CreateTestDatafileOptions,
): FlagDatafile {
  const entries: FlagDatafileEntry[] = Object.entries(flags).map(([key, value]) => ({
    id: `flag_${key}`,
    key,
    type: typeOf(value),
    enabled: true,
    defaultVariationId: `var_${key}`,
    variations: [{ id: `var_${key}`, key: 'test', value }],
    overrides: [],
    rules: [],
  }));

  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: options?.sdkKey ?? 'sdk_test_000000000000',
    environmentKey: options?.environmentKey ?? 'test',
    publishedAt: '2026-01-01T00:00:00.000Z',
    // An ORIGIN on a reserved TLD that never resolves, so a stray flush in a
    // test cannot reach a host. This used to name the REAL production ingest
    // host, which meant a test suite could deliver events to production.
    collectEndpoint: 'https://collect.test.invalid',
    flags: entries,
    audiences: [],
  };
}
