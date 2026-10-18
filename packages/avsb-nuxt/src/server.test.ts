/**
 * The server half: where the bootstrap datafile comes from, and that what it
 * hands over survives the payload.
 *
 * The load-bearing assertion is the round trip. The datafile goes into
 * `useState`, gets serialised into the HTML payload, comes back as plain JSON
 * in the browser, and is then handed to the browser client as `bootstrap`. If
 * any of that changed shape, the client would start unready and every flag on
 * the first paint would silently be a default.
 */
import { describe, expect, it, vi } from 'vitest';
import { AvsbClient } from '@avsbhq/browser';
import type { FlagDatafile } from '@avsbhq/core';
import { createTestDatafile } from '@avsbhq/vue/testing';
import {
  createDatafileLoader,
  getAvsbBootstrap,
  type AvsbServerClient,
  type DatafileFetcher,
} from './server';

const SDK_KEY = 'sdk_test_0000000000000000000';

function serverClient(datafile: FlagDatafile | null): AvsbServerClient {
  return { getDatafile: () => datafile };
}

describe('getAvsbBootstrap', () => {
  it('hands back the datafile a server client already loaded', () => {
    const datafile = createTestDatafile({ 'checkout-v2': true });
    expect(getAvsbBootstrap(serverClient(datafile))).toBe(datafile);
  });

  it('is null when the server client has not loaded one yet', () => {
    expect(getAvsbBootstrap(serverClient(null))).toBeNull();
  });

  it('round-trips through the payload and is accepted by the browser client', () => {
    const bootstrap = getAvsbBootstrap(serverClient(createTestDatafile({ 'checkout-v2': true })));

    // Exactly what Nuxt does to a useState value on its way into the HTML.
    const serialised = JSON.parse(JSON.stringify(bootstrap)) as FlagDatafile;

    const client = new AvsbClient({
      sdkKey: SDK_KEY,
      bootstrap: serialised,
      autoInit: false,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent',
    });

    expect(client.isReady()).toBe(true);
    expect(client.getBoolFlag('checkout-v2', false, { readOnly: true }).value).toBe(true);
  });
});

describe('createDatafileLoader', () => {
  function fetcherFor(datafile: FlagDatafile | null) {
    return vi.fn<DatafileFetcher>(async () => datafile);
  }

  it('fetches once and serves the cached datafile until it ages out', async () => {
    const datafile = createTestDatafile({ 'checkout-v2': true });
    const fetchDatafile = fetcherFor(datafile);
    let clock = 1_000;
    const loader = createDatafileLoader({ fetchDatafile, now: () => clock });

    expect(await loader.load(SDK_KEY, { maxAgeMs: 60_000 })).toBe(datafile);
    clock = 30_000;
    expect(await loader.load(SDK_KEY, { maxAgeMs: 60_000 })).toBe(datafile);
    expect(fetchDatafile).toHaveBeenCalledTimes(1);

    clock = 100_000;
    expect(await loader.load(SDK_KEY, { maxAgeMs: 60_000 })).toBe(datafile);
    expect(fetchDatafile).toHaveBeenCalledTimes(2);
  });

  it('collapses a burst of concurrent requests into one fetch', async () => {
    const datafile = createTestDatafile({ 'checkout-v2': true });
    let release: (value: FlagDatafile) => void = () => undefined;
    const fetchDatafile = vi.fn<DatafileFetcher>(
      () =>
        new Promise<FlagDatafile>((resolve) => {
          release = resolve;
        }),
    );
    const loader = createDatafileLoader({ fetchDatafile });

    const all = Promise.all([loader.load(SDK_KEY), loader.load(SDK_KEY), loader.load(SDK_KEY)]);
    release(datafile);

    expect(await all).toEqual([datafile, datafile, datafile]);
    expect(fetchDatafile).toHaveBeenCalledTimes(1);
  });

  it('never caches a failure, so one bad second is not a whole TTL of defaults', async () => {
    const fetchDatafile = fetcherFor(null);
    const loader = createDatafileLoader({ fetchDatafile, now: () => 1_000 });

    expect(await loader.load(SDK_KEY)).toBeNull();
    expect(await loader.load(SDK_KEY)).toBeNull();
    expect(fetchDatafile).toHaveBeenCalledTimes(2);
  });

  it('caches per CDN host, so two hosts never serve each other', async () => {
    const datafile = createTestDatafile({ 'checkout-v2': true });
    const fetchDatafile = fetcherFor(datafile);
    const loader = createDatafileLoader({ fetchDatafile, now: () => 1_000 });

    await loader.load(SDK_KEY, { cdnHost: 'https://cdn.one.example' });
    await loader.load(SDK_KEY, { cdnHost: 'https://cdn.two.example' });
    await loader.load(SDK_KEY, { cdnHost: 'https://cdn.one.example' });

    expect(fetchDatafile).toHaveBeenCalledTimes(2);
  });

  it('passes the host, the timeout and the error reporter to the fetch', async () => {
    const fetchDatafile = fetcherFor(null);
    const onError = vi.fn();
    const loader = createDatafileLoader({ fetchDatafile });

    await loader.load(SDK_KEY, {
      cdnHost: 'https://cdn.example.com',
      timeoutMs: 750,
      onError,
    });

    expect(fetchDatafile).toHaveBeenCalledWith(SDK_KEY, {
      cdnHost: 'https://cdn.example.com',
      timeout: 750,
      onError,
    });
  });

  it('refetches after clear()', async () => {
    const datafile = createTestDatafile({ 'checkout-v2': true });
    const fetchDatafile = fetcherFor(datafile);
    const loader = createDatafileLoader({ fetchDatafile, now: () => 1_000 });

    await loader.load(SDK_KEY);
    loader.clear();
    await loader.load(SDK_KEY);

    expect(fetchDatafile).toHaveBeenCalledTimes(2);
  });
});
