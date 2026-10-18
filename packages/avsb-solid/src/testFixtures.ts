/**
 * The JSX-free half of `@avsbhq/solid/testing`.
 *
 * `testing.tsx` carries a Solid component, and a component means JSX, which
 * means the file can only be read by a toolchain running `vite-plugin-solid`.
 * This package's own tests are deliberately JSX-free so they run under the
 * repo-wide runner, and they only ever wanted these two builders, so the
 * builders live here and `testing.tsx` re-exports them. The published surface
 * is unchanged: `@avsbhq/solid/testing` still exports all three names, and the
 * raw-source `solid` export condition still resolves this relative import
 * inside the same shipped package.
 */
import { AvsbClient } from '@avsbhq/browser';
import type { EvalContext, FlagDatafile } from '@avsbhq/core';

const TEST_SDK_KEY = 'sdk_test_0000000000000000000';
const TEST_CONTEXT: EvalContext = { kind: 'user', key: 'test-user' };

function flagType(value: unknown): 'boolean' | 'string' | 'number' | 'json' {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  return 'json';
}

export interface TestClientOptions {
  /**
   * flagKey to value. Each becomes a flag that is shipped to everyone, so
   * `isEnabled()` is true for truthy values and reads record exposures
   * exactly as an A/B rule would.
   */
  flags?: Record<string, unknown>;
  /** The evaluation context. Defaults to `{ kind: 'user', key: 'test-user' }`. */
  context?: EvalContext;
}

/**
 * Build the datafile a flags map describes.
 *
 * Every entry gets one variation and one A/B rule at 100%, which is what the
 * platform publishes for a flag that is fully rolled out. Reads therefore
 * report `source: 'rule'` and record an exposure, so exposure assertions mean
 * what they mean in production.
 *
 * Kept byte-for-byte equivalent to `createTestDatafile` in
 * `@avsbhq/test/fixtures`. If you change one, change both.
 */
export function createTestDatafile(
  flags: Record<string, unknown>,
  options?: {
    /**
     * A datafile is "the same one" while its `publishedAt` has not moved, so
     * pass a later timestamp to simulate a republish and watch subscribers
     * wake up.
     */
    publishedAt?: string;
  },
): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: TEST_SDK_KEY,
    environmentKey: 'test',
    publishedAt: options?.publishedAt ?? '2024-01-01T00:00:00.000Z',
    // An ORIGIN on a reserved TLD: SDKs append the `/v1/collect/*` paths
    // themselves through the core endpoint contract, so a value ending in a
    // path produced doubled URLs, and `.invalid` never resolves, so a stray
    // flush cannot reach a host.
    collectEndpoint: 'https://collect.test.invalid',
    flags: Object.entries(flags).map(([key, value], index) => ({
      id: `flag_${index}`,
      key,
      type: flagType(value),
      enabled: true,
      defaultVariationId: `var_${index}`,
      variations: [{ id: `var_${index}`, key: 'test', value }],
      overrides: [],
      rules: [
        {
          id: `rule_${index}`,
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'user.key',
          trafficAllocation: null,
          variations: [{ variationId: `var_${index}`, percentage: 1 }],
        },
      ],
    })),
    audiences: [],
    contextKinds: ['user'],
  };
}

/**
 * A real `AvsbClient`, ready on the first tick, that never touches the
 * network: the datafile is bootstrapped, polling is off, the localStorage
 * cache is off, and logging is silent.
 *
 * Call `close()` when a test is done if it tracked events, so the flush timer
 * does not outlive it.
 */
export function createTestClient(options?: TestClientOptions): AvsbClient {
  return new AvsbClient({
    sdkKey: TEST_SDK_KEY,
    context: options?.context ?? TEST_CONTEXT,
    bootstrap: createTestDatafile(options?.flags ?? {}),
    autoRefresh: false,
    cache: false,
    logLevel: 'silent',
    events: { flushInterval: 60_000 },
  });
}
