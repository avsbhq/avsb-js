/**
 * `createTestClient` builds a REAL `AvsbClient`, so these assertions are
 * about the real evaluator and the real lifecycle, not about a mock
 * agreeing with itself. The two properties that matter:
 *
 *   1. flags are readable on the first tick, with no await;
 *   2. nothing reaches the network, which is what every framework
 *      package's test docblock promises and what makes a suite fast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestClient } from './createTestClient';
import { createTestDatafile } from './fixtures/datafile';

const clients: Array<{ close: () => Promise<void> }> = [];

function track<T extends { close: () => Promise<void> }>(client: T): T {
  clients.push(client);
  return client;
}

beforeEach(() => {
  // Property 2 above was true during each test and false at teardown, which
  // is why it went unnoticed: `close()` drains the tracker on the
  // beacon-preferred path, and happy-dom's `navigator.sendBeacon` is
  // fire-and-forget by construction. It calls `window.fetch(url, ...)` and
  // discards the promise, so a beacon that fails can only ever surface as an
  // unhandled rejection with no user frame to blame it on. The fixture's
  // `.invalid` collect endpoint never resolves, so every close that carried
  // a queued exposure left one rejection behind after the test had already
  // passed, and the root suite exited 1 at zero failures.
  //
  // Stubbing both transports closes it at the seam: sendBeacon reports the
  // batch as queued, so the teardown path creates no promise at all, and the
  // fetch stub answers every other path in-process.
  //
  // jsdom (this package's own environment) has no `sendBeacon` at all, and
  // `vi.spyOn` refuses a missing method, so give it one first. Both runners
  // then take the same beacon-preferred teardown path.
  if (typeof navigator.sendBeacon !== 'function') {
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      writable: true,
      value: () => true,
    });
  }
  vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true } as Response)));
});

afterEach(async () => {
  // Close while the stubs are still installed: the teardown flush has to land
  // on the stubbed transport, not on the real one being restored underneath
  // it. Restore spies before unstubbing globals, so the `fetch` spy one test
  // below installs over the stub is undone before the stub itself goes.
  for (const client of clients.splice(0)) await client.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('createTestClient', () => {
  it('reads flags synchronously, with no await on onReady', () => {
    const client = track(createTestClient({ flags: { 'checkout-v2': true } }));
    expect(client.isReady()).toBe(true);
    expect(client.getBoolFlag('checkout-v2', false).value).toBe(true);
  });

  it('serves values through a rule, so isEnabled and exposures behave as in production', () => {
    const client = track(createTestClient({ flags: { 'checkout-v2': true } }));
    const flag = client.getBoolFlag('checkout-v2', false);
    expect(flag.source).toBe('rule');
    expect(flag.isEnabled()).toBe(true);
  });

  it('settles the init result as a bootstrap without a network round trip', () => {
    const client = track(createTestClient({ flags: { a: true } }));
    expect(client.getInitResult()).toEqual({ success: true, source: 'bootstrap' });
  });

  it('does not fetch anything at construction', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    track(createTestClient({ flags: { a: true } }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honours the runtime type check, returning the default for a mismatched type', () => {
    // The real client type-checks typed getters; a mock would happily hand
    // back the string.
    const client = track(createTestClient({ flags: { 'cta-copy': 'Buy now' } }));
    expect(client.getBoolFlag('cta-copy', false).value).toBe(false);
  });

  it('reports not_found for a key the datafile does not carry', () => {
    const client = track(createTestClient({ flags: { a: true } }));
    expect(client.getBoolFlag('nope', false).source).toBe('not_found');
  });

  it('binds the context it was given', () => {
    const client = track(
      createTestClient({ flags: { a: true }, context: { kind: 'user', key: 'u_42' } }),
    );
    expect(client.getContext()).toMatchObject({ kind: 'user', key: 'u_42' });
  });

  it('accepts a full datafile instead of a flags map', () => {
    const datafile = createTestDatafile({ 'checkout-v2': true }, { sdkKey: 'sdk_test_abcdefgh12' });
    const client = track(createTestClient({ datafile }));
    expect(client.getBoolFlag('checkout-v2', false).value).toBe(true);
  });

  it('wakes a subscriber when a later datafile changes the value', () => {
    const client = track(createTestClient({ flags: { 'checkout-v2': true } }));
    const woken = vi.fn();
    client.subscribe('checkout-v2', woken);

    client.applyDatafileBootstrap(
      createTestDatafile({ 'checkout-v2': false }, { publishedAt: '2026-06-01T00:00:00.000Z' }),
    );

    expect(woken).toHaveBeenCalled();
    expect(client.getBoolFlag('checkout-v2', true).value).toBe(false);
  });

  it('returns a referentially stable snapshot until the value changes', () => {
    // The store contract every framework adapter depends on: React bails
    // with "getSnapshot should be cached" when this is not true.
    const client = track(createTestClient({ flags: { 'checkout-v2': true } }));
    const first = client.getSnapshot('checkout-v2', false);
    expect(client.getSnapshot('checkout-v2', false)).toBe(first);
  });
});
