/**
 * N1-3 (production QA 2026-10-01): the README quick-start
 * `<AvsbProvider sdkKey=... context=...><App /></AvsbProvider>` threw
 * "the flag accessors must be called inside <AvsbProvider>" on mount.
 * `resolveClient` destructured `children` out of the props, and Solid's
 * compiled children are a lazy getter, so `<App />` (and its flag
 * accessors) ran before the provider's context existed.
 *
 * Solid's compiled JSX hands the provider exactly this shape: a props object
 * whose `children` is a getter. These tests build that object by hand, so
 * they need no JSX compiler.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AvsbClient } from '@avsbhq/browser';
import type { JSX } from 'solid-js';
import type { SolidAvsbClient } from '../clientInterface';
import type { AvsbProviderProps } from '../types';
import { createTestClient, createTestDatafile } from '../testFixtures';
import { SDK_VERSION } from '../version';
import { clientOptionsFrom, resolveClient } from './resolveClient';

const SDK_KEY = 'sdk_test_0000000000000000000';

/** Mode A props whose `children` getter counts how often it is read. */
function modeAProps(): { props: AvsbProviderProps; childrenReads: () => number } {
  let reads = 0;
  const props = {
    sdkKey: SDK_KEY,
    bootstrap: createTestDatafile({ checkout_v2: true }),
    context: { kind: 'user', key: 'u1' },
    autoInit: false,
    autoRefresh: false,
    cache: false,
    logLevel: 'silent' as const,
    get children(): JSX.Element {
      reads += 1;
      throw new Error('children were evaluated before the provider rendered them');
    },
  };
  return { props: props as unknown as AvsbProviderProps, childrenReads: () => reads };
}

const owned: SolidAvsbClient[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((client) => client.close()));
});

describe('resolveClient, Mode A (N1-3)', () => {
  it('builds the client without evaluating children', () => {
    const { props, childrenReads } = modeAProps();

    const resolved = resolveClient(props);
    owned.push(resolved.client);

    expect(childrenReads()).toBe(0);
    expect(resolved.owned).toBe(true);
    expect(resolved.client).toBeInstanceOf(AvsbClient);
  });

  it('hands every other prop to the client', () => {
    const { props } = modeAProps();

    const resolved = resolveClient(props);
    owned.push(resolved.client);

    // The bootstrap and context props reached the constructor. Read-only, so
    // no exposure is queued and close() has nothing to send.
    expect(resolved.client.getBoolFlag('checkout_v2', false, { readOnly: true }).value).toBe(true);
  });

  it('throws the actionable misuse message when there is neither a key nor a client', () => {
    const props = { children: null } as unknown as AvsbProviderProps;
    expect(() => resolveClient(props)).toThrow(/needs either an sdkKey \(Mode A\) or a client \(Mode B\)/);
  });
});

describe('resolveClient, Mode B', () => {
  it('adopts the injected client untouched and does not own it', () => {
    const client = createTestClient({ flags: { checkout_v2: true } });
    owned.push(client);
    const props = { client, children: null } as unknown as AvsbProviderProps;

    expect(resolveClient(props)).toEqual({ client, owned: false });
  });
});

describe('clientOptionsFrom', () => {
  it('copies every prop except children, and never reads the children getter', () => {
    const { props, childrenReads } = modeAProps();

    const options = clientOptionsFrom(props);

    expect(childrenReads()).toBe(0);
    expect('children' in options).toBe(false);
    expect(options.sdkKey).toBe(SDK_KEY);
    expect(options.context).toEqual({ kind: 'user', key: 'u1' });
  });
});

// N1-14: the heartbeat names @avsbhq/solid, not @avsbhq/browser.
const HEARTBEAT_URL = 'https://heartbeat.test.invalid/api/sdk/heartbeat';

describe('the solid client names itself on the heartbeat (N1-14)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports @avsbhq/solid at its package.json version', async () => {
    const heartbeats: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).includes('/datafile.json')) {
          return new Response(
            JSON.stringify({
              ...createTestDatafile({}),
              sdkKey: SDK_KEY,
              heartbeatEndpoint: HEARTBEAT_URL,
            }),
            { status: 200 },
          );
        }
        if (String(url) === HEARTBEAT_URL) {
          heartbeats.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        }
        return new Response('{}', { status: 200 });
      }),
    );
    const props = {
      sdkKey: SDK_KEY,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent' as const,
      children: null,
    } as unknown as AvsbProviderProps;

    const { client } = resolveClient(props);
    owned.push(client);
    await client.onReady();
    await vi.waitFor(() => expect(heartbeats).toHaveLength(1));

    expect(heartbeats[0]).toEqual({
      sdkKey: SDK_KEY,
      sdkType: '@avsbhq/solid',
      sdkVersion: SDK_VERSION,
    });
  });
});
