import { describe, expect, it } from 'vitest';
import { createMockClient } from './createMockClient';
import { resolveTestClient } from './resolveTestClient';

describe('resolveTestClient', () => {
  it('uses the flags map shorthand (B26)', () => {
    const client = resolveTestClient({ flags: { 'checkout-v2': true } });
    expect(client.getBoolFlag('checkout-v2', false).value).toBe(true);
  });

  it('prefers a pre-built client over everything else', () => {
    const existing = createMockClient({ flags: { 'checkout-v2': false } });
    const client = resolveTestClient({
      client: existing,
      flags: { 'checkout-v2': true },
    });

    expect(client).toBe(existing);
    expect(client.getBoolFlag('checkout-v2', true).value).toBe(false);
  });

  it('prefers full options over the flags shorthand', () => {
    const client = resolveTestClient({
      options: { flags: { 'checkout-v2': false }, context: { kind: 'user', key: 'u_1' } },
      flags: { 'checkout-v2': true },
    });

    expect(client.getBoolFlag('checkout-v2', true).value).toBe(false);
    expect(client.getContext()).toEqual({ kind: 'user', key: 'u_1' });
  });

  it('builds an empty mock when nothing is passed, rather than throwing', () => {
    const client = resolveTestClient({});
    expect(client.getBoolFlag('anything', false).source).toBe('not_found');
  });

  it('binds the context prop, so flags and context combine (B26)', () => {
    const client = resolveTestClient({
      flags: { 'checkout-v2': true },
      context: { kind: 'user', key: 'u_42', plan: 'pro' },
    });

    expect(client.getContext()).toEqual({ kind: 'user', key: 'u_42', plan: 'pro' });
    expect(client.getBoolFlag('checkout-v2', false).value).toBe(true);
  });

  it('accepts context on its own, with no flags', () => {
    const client = resolveTestClient({ context: { kind: 'organization', key: 'org_1' } });
    expect(client.getContext()).toEqual({ kind: 'organization', key: 'org_1' });
  });

  it('lets the bound context select a per-context value', () => {
    const client = resolveTestClient({
      options: {
        flags: { 'checkout-v2': false },
        flagsByUser: { 'checkout-v2:u_paying': true },
        context: { kind: 'user', key: 'u_paying' },
      },
    });
    expect(client.getBoolFlag('checkout-v2', false).value).toBe(true);
  });
});
