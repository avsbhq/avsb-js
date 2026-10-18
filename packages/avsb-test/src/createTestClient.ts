// =====================================================================
// `createTestClient` — a REAL `AvsbClient` over a fixture datafile.
//
// The difference from `createMockClient` is the whole point: this runs the
// real evaluator, the real snapshot cache, the real runtime type checks and
// the real exposure rules, so a test that passes here is testing the code
// that ships. A mock only ever agrees with itself, which is how a release
// shipped with hooks that could not render a flag.
//
// It lived four times before this (@avsbhq/react, @avsbhq/vue,
// @avsbhq/svelte, @avsbhq/solid), each with its own idea of the offline
// switches. This is the one implementation; the framework packages
// re-export it so their `./testing` entry keeps its familiar import path.
// =====================================================================

import { AvsbClient } from '@avsbhq/browser';
import type { EvalContext, FlagDatafile } from '@avsbhq/core';
import { createTestDatafile, TEST_SDK_KEY, type TestFlags } from './fixtures/datafile';

export interface TestClientOptions {
  /**
   * flagKey to value. Each entry becomes a flag served to everyone, so
   * `isEnabled()` is true for truthy values and reads record exposures
   * exactly as a fully rolled-out A/B rule would.
   */
  flags?: TestFlags;
  /** The evaluation context. Default `{ kind: 'user', key: 'test-user' }`. */
  context?: EvalContext;
  /** A full datafile, for when a map of values is not expressive enough. */
  datafile?: FlagDatafile;
}

const TEST_CONTEXT: EvalContext = { kind: 'user', key: 'test-user' };

/**
 * A real `AvsbClient`, readable on the first tick, that does not touch the
 * network: nothing is fetched at construction, polling is off, the
 * localStorage cache is off, logging is silent, and the datafile is handed
 * straight in.
 *
 * ```ts
 * const client = createTestClient({ flags: { 'checkout-v2': true } })
 * expect(client.getBoolFlag('checkout-v2', false).isEnabled()).toBe(true)
 * ```
 *
 * Call `close()` when a test is done if it tracked events, so the flush
 * timer does not outlive it.
 *
 * `await client.onReady()` is safe and starts nothing. `onReady` skips its
 * lazy init once the result has settled, which the `applyDatafileBootstrap`
 * below has already done. That guard lives in `AvsbClient.onReady` and is
 * pinned by `AvsbClient.bootstrap.test.ts`; without it every framework
 * provider awaiting readiness would put one request per test client on the
 * wire.
 */
export function createTestClient(options?: TestClientOptions): AvsbClient {
  const datafile = options?.datafile ?? createTestDatafile(options?.flags ?? {});

  const client = new AvsbClient({
    sdkKey: datafile.sdkKey || TEST_SDK_KEY,
    context: options?.context ?? TEST_CONTEXT,
    // No fetch at construction. The datafile arrives through the bootstrap
    // handoff below, which is also what wires the tracker and settles
    // `getInitResult()`, so `track` and `flush` behave as they do in
    // production instead of queueing forever behind a tracker that a
    // failed background fetch never created.
    autoInit: false,
    autoRefresh: false,
    cache: false,
    logLevel: 'silent',
    // Long enough that the automatic flush never fires mid-test. Assert on
    // events with an explicit `await client.flush()`.
    events: { flushInterval: 60_000 },
  });

  client.applyDatafileBootstrap(datafile);
  return client;
}
