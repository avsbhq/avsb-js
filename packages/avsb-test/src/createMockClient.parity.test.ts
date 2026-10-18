/**
 * N1-10 (production QA 2026-10-01): the browser-shaped mock's gaps against
 * the real `AvsbClient` were `utils`, `applySnapshot` and `onFlagChange`.
 * `CLIENT_SURFACE` lists every public member of AvsbClient; `satisfies`
 * makes the compiler reject a missing or an extra name, so a public method
 * added to AvsbClient fails the typecheck until it is listed, and then fails
 * the runtime check below until the mock has it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlag } from '@avsbhq/core';
import { AvsbClient } from '@avsbhq/browser';
import { createMockClient } from './createMockClient';
import { createTestDatafile } from './fixtures/datafile';

const CLIENT_SURFACE = {
  utils: true,
  onReady: true,
  isReady: true,
  getInitResult: true,
  identify: true,
  updateAttributes: true,
  alias: true,
  getContext: true,
  reset: true,
  getFlag: true,
  getBoolFlag: true,
  getStringFlag: true,
  getNumberFlag: true,
  getJsonFlag: true,
  track: true,
  getAllFlags: true,
  setOverrideForUser: true,
  setGlobalOverride: true,
  clearOverrideForUser: true,
  clearGlobalOverride: true,
  clearAllOverrides: true,
  subscribe: true,
  getSnapshot: true,
  on: true,
  onFlagChange: true,
  applyDatafileBootstrap: true,
  applySnapshot: true,
  refresh: true,
  flush: true,
  close: true,
} satisfies Record<keyof AvsbClient, boolean>;

const clients: AvsbClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

function realClient(): AvsbClient {
  const client = new AvsbClient({
    sdkKey: 'sdk_test_0000000000000000000',
    bootstrap: { ...createTestDatafile({ checkout_v2: true }), collectEndpoint: 'https://collect.test.invalid' },
    autoInit: false,
    autoRefresh: false,
    cache: false,
    logLevel: 'silent',
  });
  clients.push(client);
  return client;
}

describe('createMockClient mirrors the AvsbClient surface (N1-10)', () => {
  it('has every public AvsbClient member, with the same kind of value', () => {
    const real = realClient() as unknown as Record<string, unknown>;
    const mock = createMockClient({ flags: { checkout_v2: true } }) as unknown as Record<string, unknown>;

    const names = Object.keys(CLIENT_SURFACE);
    expect(names.filter((name) => mock[name] === undefined)).toEqual([]);
    for (const name of names) expect(typeof mock[name], name).toBe(typeof real[name]);
  });

  it('gives utils the same helpers as the real client', () => {
    const real = realClient();
    const mock = createMockClient();
    expect(Object.keys(mock.utils).sort()).toEqual(Object.keys(real.utils).sort());
  });
});

describe('createMockClient: the members it gained', () => {
  it('onFlagChange reports a value change in the three-argument shape', () => {
    const client = createMockClient({ flags: { theme: 'light' } });
    const changes = vi.fn();
    const stop = client.onFlagChange(changes);

    client._setFlag('theme', 'dark');
    stop();
    client._setFlag('theme', 'blue');

    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledWith('theme', 'dark', 'light');
  });

  it('applySnapshot adopts server-evaluated values and makes the mock ready', () => {
    const client = createMockClient({ ready: false });
    const woken = vi.fn();
    client.subscribe('checkout_v2', woken);

    client.applySnapshot({
      capturedAt: 1_700_000_000_000,
      datafileVersion: '2026-10-01T00:00:00.000Z',
      flags: {
        checkout_v2: createFlag<unknown>({
          value: true,
          variationKey: 'on',
          source: 'rule',
          ruleId: 'r1',
          ruleType: 'ab_test',
          reasons: [],
        }),
      },
      contextSummary: [{ kind: 'user', key: 'test-user' }],
    });

    expect(client.isReady()).toBe(true);
    expect(client.getBoolFlag('checkout_v2', false).value).toBe(true);
    expect(woken).toHaveBeenCalled();
  });

  it('utils.snapshot reads the mock values, and hydrateBootstrap adopts a datafile', () => {
    const client = createMockClient({ flags: { theme: 'dark' }, ready: false });

    client.utils.hydrateBootstrap({
      format: 'avsb-bootstrap-v1',
      producedAt: 1,
      snapshot: {
        capturedAt: 1,
        datafileVersion: '2026-10-01T00:00:00.000Z',
        flags: {},
        contextSummary: [{ kind: 'user', key: 'test-user' }],
      },
      datafile: createTestDatafile({ checkout_v2: true }),
    });

    expect(client.isReady()).toBe(true);
    expect(client.utils.snapshot().flags['theme']?.value).toBe('dark');
    expect(client.getBoolFlag('checkout_v2', false).value).toBe(true);
  });
});
