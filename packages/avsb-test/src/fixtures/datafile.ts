// =====================================================================
// `createTestDatafile` — ONE datafile builder for the whole SDK family.
//
// It existed five times before this: here (taking hand-built
// `FlagDatafileEntry` objects), and again inside @avsbhq/react,
// @avsbhq/vue, @avsbhq/svelte and @avsbhq/solid, each taking a flagKey to
// value MAP and each writing slightly different rules, endpoints and
// timestamps. Five builders meant a test could pass against one framework's
// idea of "a flag that is on" and fail against another's.
//
// The map IS the shape people write, so the map is the first parameter.
// Hand-built entries stay reachable through `options.entries`, for the tests
// that need real audiences, partial rollouts or per-user overrides.
//
// BREAKING (SDK/API DX overhaul session 9): the first parameter used to be
// the options bag, so `createTestDatafile({ flags: [entry] })` becomes
// `createTestDatafile({}, { entries: [entry] })`. TypeScript rejects the old
// call rather than silently building an empty datafile.
// =====================================================================

import type { FlagDatafile, FlagDatafileEntry } from '@avsbhq/core';

/** What a flag can be set to in a test. */
export type TestFlagValue = boolean | string | number | object | null;

/** Flag key to value: `{ 'checkout-v2': true }`. */
export type TestFlags = Record<string, TestFlagValue>;

export interface CreateTestDatafileOptions {
  /** SDK key written into the datafile. Default `sdk_test_0000000000000000000`. */
  sdkKey?: string;
  /** Environment key written into the datafile. Default `test`. */
  environmentKey?: string;
  /**
   * A datafile is "the same one" while its `publishedAt` has not moved, so
   * pass a later timestamp to simulate a republish and watch subscribers
   * wake up. Default `2024-01-01T00:00:00.000Z`.
   */
  publishedAt?: string;
  /**
   * Hand-built entries, appended after the ones the map produces. Use these
   * when a test needs audiences, a partial rollout, or per-user overrides,
   * which a value map cannot express.
   */
  entries?: FlagDatafileEntry[];
}

/** The default key. Real-shaped, so the SDK's key check stays quiet. */
export const TEST_SDK_KEY = 'sdk_test_0000000000000000000';

function flagType(value: TestFlagValue): FlagDatafileEntry['type'] {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  return 'json';
}

function entryFor(key: string, value: TestFlagValue, index: number): FlagDatafileEntry {
  const variationId = `var_${index}`;
  return {
    id: `flag_${index}`,
    key,
    type: flagType(value),
    enabled: true,
    defaultVariationId: variationId,
    variations: [{ id: variationId, key: 'test', value }],
    overrides: [],
    rules: [
      {
        id: `rule_${index}`,
        type: 'ab_test',
        enabled: true,
        audienceIds: [],
        hashAttribute: 'user.key',
        trafficAllocation: null,
        // `percentage` is a 0..1 proportion (the evaluator multiplies it by
        // 10000), so this is the whole audience.
        variations: [{ variationId, percentage: 1 }],
      },
    ],
  };
}

/**
 * Build the datafile a flags map describes.
 *
 * Every entry gets one variation and one A/B rule serving 100% of traffic,
 * which is what the platform publishes for a flag that is fully rolled out.
 * Reads therefore report `source: 'rule'` and record an exposure, so
 * exposure assertions in a test mean what they mean in production. A builder
 * that served values through `defaultVariationId` instead would report
 * `source: 'default'` and fire nothing, and every exposure test written
 * against it would be green for the wrong reason.
 *
 * ```ts
 * const datafile = createTestDatafile({
 *   'checkout-v2': true,
 *   'cta-copy': 'Buy now',
 * })
 * ```
 */
export function createTestDatafile(
  flags?: TestFlags,
  options?: CreateTestDatafileOptions,
): FlagDatafile {
  const mapped = Object.entries(flags ?? {}).map(([key, value], index) =>
    entryFor(key, value, index),
  );

  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: options?.sdkKey ?? TEST_SDK_KEY,
    environmentKey: options?.environmentKey ?? 'test',
    publishedAt: options?.publishedAt ?? '2024-01-01T00:00:00.000Z',
    // An ORIGIN, the way the publisher writes it: SDKs append the
    // `/v1/collect/*` paths themselves through the core endpoint contract.
    // The `.invalid` TLD is reserved and never resolves, so a stray flush in
    // a test cannot reach a real host.
    collectEndpoint: 'https://collect.test.invalid',
    flags: [...mapped, ...(options?.entries ?? [])],
    audiences: [],
    holdouts: [],
    bandits: [],
    // `bigSegments` deliberately absent: the field was deleted from the
    // datafile type (breaking change B28) because nothing evaluated it.
    contextKinds: ['user'],
    exposureSampling: 1,
  };
}
