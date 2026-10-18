/**
 * The parts of the mock that were missing until the packaging pass: the
 * lifecycle trio the framework adapters call at construction, runtime
 * overrides, `GetFlagOptions`, the bootstrap handoff, and `refresh`.
 *
 * Why it matters: @avsbhq/angular types `provideAvsb({ client })` against
 * `AngularAvsbClient`, and `AvsbService` calls `isReady()`,
 * `getInitResult()` and `on('ready')` in its constructor. A mock missing one
 * of those is not a weaker mock, it is a TypeError on injection.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMockClient } from './createMockClient';
import { createTestDatafile } from './fixtures/datafile';

describe('createMockClient — lifecycle', () => {
  it('is ready on construction by default and reports a settled init result', () => {
    const client = createMockClient({ flags: { a: true } });
    expect(client.isReady()).toBe(true);
    expect(client.getInitResult()).toEqual({ success: true, source: 'bootstrap' });
  });

  it('is not ready when ready:false, and getInitResult stays null until _markReady', () => {
    const client = createMockClient({ flags: { a: true }, ready: false });
    expect(client.isReady()).toBe(false);
    expect(client.getInitResult()).toBeNull();

    client._markReady();
    expect(client.isReady()).toBe(true);
    expect(client.getInitResult()).toEqual({ success: true, source: 'network' });
  });

  it('returns not_ready, never not_found, before it is ready', () => {
    // B15: "you asked too early" and "that flag does not exist" are
    // different problems with different fixes.
    const client = createMockClient({ flags: { a: true }, ready: false });
    const flag = client.getBoolFlag('a', false);
    expect(flag.source).toBe('not_ready');
    expect(flag.value).toBe(false);
  });

  it('records nothing for a not_ready read', () => {
    const client = createMockClient({ flags: { a: true }, ready: false });
    client.getBoolFlag('a', false);
    expect(client._evaluations()).toEqual([]);
  });

  it('onReady resolves with the settled result', async () => {
    const client = createMockClient({ ready: false });
    const pending = client.onReady();
    client._markReady({ success: true, source: 'bootstrap' });
    await expect(pending).resolves.toEqual({ success: true, source: 'bootstrap' });
  });

  it('onReady({timeout}) resolves as a failure when the mock never becomes ready', async () => {
    vi.useFakeTimers();
    try {
      const client = createMockClient({ ready: false });
      const pending = client.onReady({ timeout: 50 });
      await vi.advanceTimersByTimeAsync(60);
      await expect(pending).resolves.toEqual({ success: false, source: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts refresh calls and announces a config update', async () => {
    const client = createMockClient();
    const seen = vi.fn();
    client.on('configUpdate', seen);

    await client.refresh();
    await client.refresh();

    expect(client._refreshCount()).toBe(2);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});

describe('createMockClient — identity', () => {
  it('alias records one avsb_alias event, synchronously, with no promise to await', () => {
    const client = createMockClient();
    client.alias({ kind: 'user', key: 'anon_1' }, { kind: 'user', key: 'u_1' });

    // Synchronous: the event is already recorded on the next line, with no
    // await, which is what the real client does since the alias rewrite.
    expect(client._tracked()).toEqual([{ eventKey: 'avsb_alias', payload: undefined }]);
  });

  it('identify wakes every flag subscriber, because values can change under them', () => {
    const client = createMockClient({
      flags: { 'checkout-v2': false },
      flagsByUser: { 'checkout-v2:u_paying': true },
    });
    const woken = vi.fn();
    client.subscribe('checkout-v2', woken);

    client.identify({ kind: 'user', key: 'u_paying' });

    expect(woken).toHaveBeenCalled();
    expect(client.getBoolFlag('checkout-v2', false).value).toBe(true);
  });

  it('reset drops overrides along with the recorded history', () => {
    const client = createMockClient({ flags: { 'checkout-v2': false } });
    client.setGlobalOverride('checkout-v2', 'treatment');
    client.track('purchase');

    client.reset();

    expect(client._tracked()).toEqual([]);
    expect(client.getBoolFlag('checkout-v2', true).source).toBe('rule');
  });
});

describe('createMockClient — GetFlagOptions', () => {
  it('readOnly reads record no evaluation, because a render is not a decision', () => {
    const client = createMockClient({ flags: { a: true } });
    client.getBoolFlag('a', false, { readOnly: true });
    expect(client._evaluations()).toEqual([]);
  });

  it('a normal read does record an evaluation', () => {
    const client = createMockClient({ flags: { a: true } });
    client.getBoolFlag('a', false);
    expect(client._evaluations()).toEqual([{ flagKey: 'a', value: true, contextKey: 'test-user' }]);
  });

  it('getSnapshot records nothing either', () => {
    const client = createMockClient({ flags: { a: true } });
    expect(client.getSnapshot('a', false).value).toBe(true);
    expect(client._evaluations()).toEqual([]);
  });

  it('getAllFlags is exposure-off by default and records on request', () => {
    const client = createMockClient({ flags: { a: true, b: 'two' } });

    client.getAllFlags();
    expect(client._evaluations()).toEqual([]);

    client.getAllFlags({ fireExposures: true });
    expect(
      client
        ._evaluations()
        .map((e) => e.flagKey)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('getAllFlags({context}) answers for the context it was asked about', () => {
    const client = createMockClient({
      flags: { 'checkout-v2': false },
      flagsByUser: { 'checkout-v2:u_paying': true },
    });

    const forOther = client.getAllFlags({ context: { kind: 'user', key: 'u_paying' } });
    expect(forOther['checkout-v2'].value).toBe(true);
    // The bound context is unchanged.
    expect(client.getBoolFlag('checkout-v2', true).value).toBe(false);
  });
});

describe('createMockClient — runtime overrides', () => {
  it('a global override beats the flags map', () => {
    const client = createMockClient({ flags: { 'cta-copy': 'Buy' } });
    client.setGlobalOverride('cta-copy', 'Buy now');

    const flag = client.getStringFlag('cta-copy', 'fallback');
    expect(flag.value).toBe('Buy now');
    expect(flag.source).toBe('runtimeOverride');
  });

  it('a per-context override beats a global one for that context only', () => {
    const client = createMockClient({ context: { kind: 'user', key: 'alice' } });
    client.setGlobalOverride('checkout-v2', 'treatment');
    client.setOverrideForUser('checkout-v2', 'alice', 'control');

    expect(client.getFlag('checkout-v2', '').variationKey).toBe('control');

    client.identify({ kind: 'user', key: 'bob' });
    expect(client.getFlag('checkout-v2', '').variationKey).toBe('treatment');
  });

  it('setting an override wakes that flag subscribers', () => {
    const client = createMockClient({ flags: { a: false } });
    const woken = vi.fn();
    client.subscribe('a', woken);

    client.setGlobalOverride('a', 'on');
    expect(woken).toHaveBeenCalledTimes(1);
  });

  it('clearAllOverrides restores the underlying values', () => {
    const client = createMockClient({ flags: { a: false } });
    client.setGlobalOverride('a', 'on');
    client.clearAllOverrides();

    const flag = client.getBoolFlag('a', true);
    expect(flag.source).toBe('rule');
    expect(flag.value).toBe(false);
  });

  it('an override for an unknown flag still shows up in getAllFlags', () => {
    const client = createMockClient();
    client.setGlobalOverride('ghost', 'on');
    expect(Object.keys(client.getAllFlags())).toContain('ghost');
  });
});

describe('createMockClient — bootstrap handoff', () => {
  it('applyDatafileBootstrap makes a not-ready mock readable', () => {
    const client = createMockClient({ ready: false });
    client.applyDatafileBootstrap(createTestDatafile({ 'checkout-v2': true }));

    expect(client.isReady()).toBe(true);
    expect(client.getBoolFlag('checkout-v2', false).value).toBe(true);
  });

  it('records the datafile it was given', () => {
    const client = createMockClient();
    const datafile = createTestDatafile({ a: 1 });
    client.applyDatafileBootstrap(datafile);
    expect(client._datafile()).toBe(datafile);
  });

  it('wakes subscribers, because every value changed under them', () => {
    const client = createMockClient({ ready: false });
    const woken = vi.fn();
    client.subscribe('checkout-v2', woken);

    client.applyDatafileBootstrap(createTestDatafile({ 'checkout-v2': true }));
    expect(woken).toHaveBeenCalled();
  });

  it('settles the init result as a bootstrap', () => {
    const client = createMockClient({ ready: false });
    client.applyDatafileBootstrap(createTestDatafile({}));
    expect(client.getInitResult()).toEqual({ success: true, source: 'bootstrap' });
  });
});
