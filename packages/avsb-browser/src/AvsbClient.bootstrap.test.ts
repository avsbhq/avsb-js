// The SSR bootstrap handoff, end to end (report 02 §5.6, spec WS2 item 5).
//
// `serializeBootstrap` produced blobs for a whole release while
// `hydrateBootstrap` did nothing on this client, because neither
// `applyDatafile` nor `applySnapshot` existed. These tests drive the real
// blob shape through the real client.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlag } from '@avsbhq/core';
import type { FlagDatafile } from '@avsbhq/core';
import type { BootstrapBlob, FlagSnapshot } from '@avsbhq/utils';
import { AvsbClient } from './AvsbClient';

const DATAFILE: FlagDatafile = {
  version: 2,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk_test_bootstrap',
  environmentKey: 'production',
  publishedAt: '2026-05-28T00:00:00.000Z',
  collectEndpoint: 'https://collect.test',
  flags: [
    {
      id: 'flag1',
      key: 'checkout-v2',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var_off',
      variations: [
        { id: 'var_off', key: 'off', value: false },
        { id: 'var_on', key: 'on', value: true },
      ],
      overrides: [],
      rules: [
        {
          id: 'rule1',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var_on', percentage: 1 }],
        },
      ],
    },
  ],
  audiences: [],
};

function serverSnapshot(): FlagSnapshot {
  return {
    capturedAt: 1_700_000_000_000,
    datafileVersion: DATAFILE.publishedAt,
    flags: {
      'checkout-v2': createFlag<unknown>({
        value: true,
        variationKey: 'on',
        source: 'rule',
        ruleId: 'rule1',
        ruleType: 'targeted_delivery',
        reasons: ['matched rule rule1'],
      }),
      'server-only-flag': createFlag<unknown>({
        value: 'blue',
        variationKey: 'blue',
        source: 'rule',
        ruleId: 'rule9',
        ruleType: 'ab_test',
        reasons: [],
      }),
    },
    contextSummary: [{ kind: 'user', key: 'u_1' }],
  };
}

function snapshotOnlyBlob(): BootstrapBlob {
  return {
    format: 'avsb-bootstrap-v1',
    snapshot: serverSnapshot(),
    producedAt: 1_700_000_000_000,
  };
}

function newClient(): AvsbClient {
  return new AvsbClient({
    sdkKey: 'sdk_test_bootstrap',
    context: { kind: 'user', key: 'u_1' },
    autoInit: false,
    cache: false,
    autoRefresh: false,
  });
}

describe('AvsbClient.applySnapshot', () => {
  let client: AvsbClient;

  beforeEach(() => {
    localStorage.clear();
    client = newClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it('serves the server-evaluated value instead of not_ready', () => {
    expect(client.getFlag('checkout-v2', false).source).toBe('not_ready');

    client.applySnapshot(serverSnapshot());

    const flag = client.getBoolFlag('checkout-v2', false);
    expect(flag.value).toBe(true);
    expect(flag.source).toBe('rule');
    expect(flag.isEnabled()).toBe(true);
  });

  it('marks the client readable and settles onReady as a bootstrap', async () => {
    client.applySnapshot(serverSnapshot());

    expect(client.isReady()).toBe(true);
    await expect(client.onReady()).resolves.toEqual({
      success: true,
      source: 'bootstrap',
    });
  });

  it('appends a provenance reason naming the snapshot', () => {
    client.applySnapshot(serverSnapshot());

    const reasons = client.getFlag('checkout-v2', false).reasons;
    expect(reasons[0]).toBe('matched rule rule1');
    expect(reasons[reasons.length - 1]).toContain('server bootstrap snapshot');
  });

  it('keeps getSnapshot referentially stable, so a render loop cannot start', () => {
    client.applySnapshot(serverSnapshot());

    expect(client.getSnapshot('checkout-v2', false)).toBe(client.getSnapshot('checkout-v2', false));
  });

  it('wakes flag subscribers so a mounted adapter re-reads', () => {
    const listener = vi.fn();
    client.subscribe('checkout-v2', listener);

    client.applySnapshot(serverSnapshot());

    expect(listener).toHaveBeenCalled();
  });

  it('answers getAllFlags from the snapshot before any datafile exists', () => {
    client.applySnapshot(serverSnapshot());

    const all = client.getAllFlags();
    expect(Object.keys(all).sort()).toEqual(['checkout-v2', 'server-only-flag']);
    expect(all['server-only-flag']?.value).toBe('blue');
  });

  it('returns not_found for a key the snapshot never carried', () => {
    // N1-16 (production QA 2026-10-01): this used to answer `not_ready`, then
    // flip to `not_found` once the datafile loaded. The server evaluated every
    // flag in its datafile, so a key the snapshot lacks is not in it: the
    // answer is `not_found` from the first read, the same one local
    // evaluation gives after hydration.
    client.applySnapshot(serverSnapshot());

    expect(client.getFlag('never-evaluated', 'fallback').source).toBe('not_found');
    expect(client.getFlag('never-evaluated', 'fallback').value).toBe('fallback');
  });

  it('fires no exposure while serving snapshot values', () => {
    const exposures = vi.fn();
    client.on('exposure', exposures);

    client.applySnapshot(serverSnapshot());
    client.getBoolFlag('checkout-v2', false);

    expect(exposures).not.toHaveBeenCalled();
  });

  it('hands over to local evaluation once a real datafile arrives', () => {
    client.applySnapshot(serverSnapshot());
    expect(client.getFlag('server-only-flag', 'red').value).toBe('blue');

    client.applyDatafileBootstrap(DATAFILE);

    // The datafile has no such flag, so the honest answer is now not_found:
    // the snapshot is released rather than shadowing live evaluation.
    const flag = client.getFlag('server-only-flag', 'red');
    expect(flag.source).toBe('not_found');
    expect(flag.value).toBe('red');
    // The key the datafile DOES carry still evaluates, locally now.
    expect(client.getBoolFlag('checkout-v2', false).source).toBe('rule');
  });
});

describe('client.utils.hydrateBootstrap', () => {
  let client: AvsbClient;

  beforeEach(() => {
    localStorage.clear();
    client = newClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it('applies a snapshot-only blob and reports what it did', () => {
    const result = client.utils.hydrateBootstrap(snapshotOnlyBlob());

    expect(result).toEqual({
      datafileApplied: false,
      snapshotApplied: true,
      flagCount: 2,
    });
    expect(client.getBoolFlag('checkout-v2', false).value).toBe(true);
  });

  it('applies both halves when the blob carries the datafile', () => {
    const result = client.utils.hydrateBootstrap({
      ...snapshotOnlyBlob(),
      datafile: DATAFILE,
    });

    expect(result.datafileApplied).toBe(true);
    expect(result.snapshotApplied).toBe(true);
    // Datafile wins: local evaluation is live from here.
    expect(client.getBoolFlag('checkout-v2', false).source).toBe('rule');
    // The snapshot's extra key does NOT shadow the datafile's answer: the
    // datafile is applied first, so the snapshot adoption is skipped.
    expect(client.getFlag('server-only-flag', 'red').source).toBe('not_found');
  });

  it('ignores a snapshot once a datafile is loaded', () => {
    client.applyDatafileBootstrap(DATAFILE);
    client.applySnapshot(serverSnapshot());

    expect(client.getBoolFlag('checkout-v2', false).source).toBe('rule');
    expect(client.getFlag('server-only-flag', 'red').source).toBe('not_found');
  });

  it('rejects a blob that is not a bootstrap blob', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test feeds malformed input
      client.utils.hydrateBootstrap({ format: 'nope' } as any),
    ).toThrow(/Invalid bootstrap blob/);
  });
});

// ---------------------------------------------------------------------------
// onReady must not start a fetch once init has already settled.
//
// The regression: `onReady()` began init whenever `initStarted` was false,
// including on a client whose result was already decided by
// `applyDatafileBootstrap` or `applySnapshot`. Nothing that request returned
// could change the answer, because `settleInit` keeps the first successful
// result, and the client it belongs to had been told `autoInit: false`.
//
// That is exactly the shape of `createTestClient` in @avsbhq/test: datafile
// handed straight in, then a framework provider awaits readiness. Without the
// guard, every test client dials the production CDN once.
//
// NOTE for anyone reading the history: a client constructed WITH the
// `bootstrap` option and autoInit left on never had this problem, because
// `initialize()` early-returns on `datafileSource === 'bootstrap'` before it
// fetches anything. The hole is specific to the deferred-init path.
// ---------------------------------------------------------------------------

describe('AvsbClient.onReady — no fetch once init has settled', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: AvsbClient;

  beforeEach(() => {
    localStorage.clear();
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(DATAFILE),
    });
    // Stub through vitest rather than assigning `globalThis.fetch` directly:
    // assignment only works while the environment leaves `fetch` a writable
    // own property, and if it ever stops being one the throw lands in this
    // hook, before `client` is assigned, so afterEach fails too. stubGlobal
    // defines the property and unstubAllGlobals restores the original.
    vi.stubGlobal('fetch', fetchMock);
    client = newClient();
  });

  afterEach(async () => {
    await client.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves without requesting anything after applyDatafileBootstrap', async () => {
    client.applyDatafileBootstrap(DATAFILE);

    await expect(client.onReady()).resolves.toEqual({
      success: true,
      source: 'bootstrap',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves without requesting anything after applySnapshot', async () => {
    client.applySnapshot(serverSnapshot());

    await expect(client.onReady()).resolves.toEqual({
      success: true,
      source: 'bootstrap',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still resolves with the settled result when a timeout is passed', async () => {
    // The timeout branch is unchanged: it races the already-resolved ready
    // promise against a timer, so it answers with the real result, not a
    // timeout result, and still starts nothing.
    client.applyDatafileBootstrap(DATAFILE);

    await expect(client.onReady({ timeout: 5_000 })).resolves.toEqual({
      success: true,
      source: 'bootstrap',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is idempotent: a second onReady starts nothing either', async () => {
    client.applyDatafileBootstrap(DATAFILE);

    await client.onReady();
    await client.onReady();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('STILL starts init on an autoInit:false client that has no bootstrap', async () => {
    // The lazy-start behaviour itself is preserved. Only the already-settled
    // case is skipped, so deferring the load and then awaiting readiness is
    // still the documented way to begin it.
    await client.onReady();

    const datafileCall = fetchMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === 'string' && String(call[0]).includes('datafile.json'),
    );
    expect(datafileCall).toBeDefined();
  });
});
