import { describe, expect, it } from 'vitest';
import type { EvalContext } from '@avsbhq/core';
import { createMockOverrideStore, overrideContextKeyOf } from './mockOverrides';

const ALICE: EvalContext = { kind: 'user', key: 'alice' };
const BOB: EvalContext = { kind: 'user', key: 'bob' };

describe('overrideContextKeyOf', () => {
  it('reads key and kind straight off a single context', () => {
    expect(overrideContextKeyOf({ kind: 'organization', key: 'org_1' })).toEqual({
      key: 'org_1',
      kind: 'organization',
    });
  });

  it('addresses a multi-context by its user sub-context', () => {
    const multi: EvalContext = {
      kind: 'multi',
      user: { kind: 'user', key: 'alice' },
      organization: { kind: 'organization', key: 'org_1' },
    } as EvalContext;
    expect(overrideContextKeyOf(multi)).toEqual({ key: 'alice', kind: 'user' });
  });

  it('returns an empty key for a multi-context with no user part', () => {
    const multi: EvalContext = {
      kind: 'multi',
      organization: { kind: 'organization', key: 'org_1' },
    } as EvalContext;
    expect(overrideContextKeyOf(multi).key).toBe('');
  });
});

describe('createMockOverrideStore', () => {
  it('returns null when no override was set for the flag', () => {
    const store = createMockOverrideStore();
    expect(store.resolve('checkout-v2', ALICE)).toBeNull();
  });

  it('serves a global override to every context', () => {
    const store = createMockOverrideStore();
    store.setGlobal('checkout-v2', 'treatment');

    expect(store.resolve('checkout-v2', ALICE)?.variationKey).toBe('treatment');
    expect(store.resolve('checkout-v2', BOB)?.variationKey).toBe('treatment');
  });

  it('reports source runtimeOverride with a reason naming the variation', () => {
    const store = createMockOverrideStore();
    store.setGlobal('checkout-v2', 'treatment');

    const flag = store.resolve('checkout-v2', ALICE);
    expect(flag?.source).toBe('runtimeOverride');
    expect(flag?.reasons).toEqual(['runtime override: variationKey=treatment']);
  });

  it('lets a per-context override beat a global one', () => {
    const store = createMockOverrideStore();
    store.setGlobal('checkout-v2', 'treatment');
    store.setForContext('checkout-v2', 'alice', 'control', 'user');

    expect(store.resolve('checkout-v2', ALICE)?.variationKey).toBe('control');
    expect(store.resolve('checkout-v2', BOB)?.variationKey).toBe('treatment');
  });

  it('keys per-context overrides by kind as well as key', () => {
    const store = createMockOverrideStore();
    store.setForContext('checkout-v2', 'alice', 'control', 'organization');

    // Same key, different kind: the user context must not pick it up.
    expect(store.resolve('checkout-v2', ALICE)).toBeNull();
    expect(store.resolve('checkout-v2', { kind: 'organization', key: 'alice' })?.variationKey).toBe(
      'control',
    );
  });

  it('uses the variation key itself as the value when nothing is known about it', () => {
    // An override set before any flags exist must not be silently discarded,
    // which is the rule the real browser store follows.
    const store = createMockOverrideStore();
    store.setGlobal('cta-copy', 'Buy now');

    expect(store.resolve('cta-copy', ALICE)?.value).toBe('Buy now');
  });

  it('prefers the known value for that variation key when the fixture has one', () => {
    const store = createMockOverrideStore();
    store.setGlobal('checkout-v2', 'treatment');

    const flag = store.resolve('checkout-v2', ALICE, { treatment: { layout: 'wide' } });
    expect(flag?.value).toEqual({ layout: 'wide' });
  });

  it('clears a per-context override and falls back to the global one', () => {
    const store = createMockOverrideStore();
    store.setGlobal('checkout-v2', 'treatment');
    store.setForContext('checkout-v2', 'alice', 'control', 'user');
    store.clearForContext('checkout-v2', 'alice', 'user');

    expect(store.resolve('checkout-v2', ALICE)?.variationKey).toBe('treatment');
  });

  it('clears a global override without touching per-context ones', () => {
    const store = createMockOverrideStore();
    store.setGlobal('checkout-v2', 'treatment');
    store.setForContext('checkout-v2', 'alice', 'control', 'user');
    store.clearGlobal('checkout-v2');

    expect(store.resolve('checkout-v2', ALICE)?.variationKey).toBe('control');
    expect(store.resolve('checkout-v2', BOB)).toBeNull();
  });

  it('clearAll empties the store and its key list', () => {
    const store = createMockOverrideStore();
    store.setGlobal('a', 'x');
    store.setForContext('b', 'alice', 'y', 'user');
    expect(store.keys().sort()).toEqual(['a', 'b']);

    store.clearAll();
    expect(store.keys()).toEqual([]);
    expect(store.resolve('a', ALICE)).toBeNull();
  });
});
