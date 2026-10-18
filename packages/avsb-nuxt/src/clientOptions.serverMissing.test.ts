/**
 * N1-16 (production QA 2026-10-01) on the Nuxt side: during server
 * rendering the module builds a client from the request's datafile with no
 * network (see ./clientOptions). A key that datafile does not carry must
 * read `not_found`, the answer the browser gives after hydration, never
 * `not_ready`. These drive the real browser client with the real options.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FlagDatafile } from '@avsbhq/core';
import { AvsbClient } from '@avsbhq/browser';
import { buildAvsbClientOptions } from './clientOptions';

const SDK_KEY = 'sdk_production_nuxtservermiss01';

const DATAFILE: FlagDatafile = {
  version: 2,
  projectType: 'FEATURE_FLAG',
  sdkKey: SDK_KEY,
  environmentKey: 'production',
  publishedAt: '2026-10-01T00:00:00.000Z',
  collectEndpoint: 'https://collect.test.invalid',
  flags: [
    {
      id: 'flag_1',
      key: 'checkout_v2',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var_on',
      variations: [{ id: 'var_on', key: 'on', value: true }],
      overrides: [],
      rules: [],
    },
  ],
  audiences: [],
};

const clients: AvsbClient[] = [];
function serverClient(): AvsbClient {
  const client = new AvsbClient({
    ...buildAvsbClientOptions({
      sdkKey: SDK_KEY,
      isServer: true,
      bootstrap: DATAFILE,
      context: { kind: 'user', key: 'u_1' },
    }),
    logLevel: 'silent',
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('the Nuxt server-render client', () => {
  it('reads a key the datafile does not carry as not_found with the caller default', () => {
    const flag = serverClient().getBoolFlag('missing_flag', true, { readOnly: true });
    expect(flag.source).toBe('not_found');
    expect(flag.value).toBe(true);
  });

  it('answers a key the datafile carries from that datafile', () => {
    const flag = serverClient().getBoolFlag('checkout_v2', false, { readOnly: true });
    expect(flag.source).toBe('default');
    expect(flag.value).toBe(true);
  });

  it('never answers not_ready, because the datafile is there from the first read', () => {
    const client = serverClient();
    expect(client.isReady()).toBe(true);
    expect(client.getFlag('missing_flag', 'x', { readOnly: true }).source).not.toBe('not_ready');
  });
});
