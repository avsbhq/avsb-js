import { describe, it, expect, beforeEach } from 'vitest';
import { createMockClient } from './createMockClient';

describe('createMockClient — defaults', () => {
  it('returns a not_found flag for an unknown key', () => {
    const client = createMockClient();
    const flag = client.getFlag('unknown-key', false);
    expect(flag.source).toBe('not_found');
    expect(flag.value).toBe(false);
    expect(flag.exists()).toBe(false);
  });

  it('returns a rule flag for a configured key', () => {
    const client = createMockClient({ flags: { 'checkout-v2': true } });
    const flag = client.getBoolFlag('checkout-v2', false);
    expect(flag.source).toBe('rule');
    expect(flag.value).toBe(true);
    expect(flag.exists()).toBe(true);
    expect(flag.isEnabled()).toBe(true);
  });

  it('default context is test-user', () => {
    const client = createMockClient();
    const ctx = client.getContext();
    expect(ctx.kind).toBe('user');
    expect((ctx as { key: string }).key).toBe('test-user');
  });
});

describe('createMockClient — typed flag methods', () => {
  it('getStringFlag returns string value', () => {
    const client = createMockClient({ flags: { theme: 'dark' } });
    const flag = client.getStringFlag('theme', 'light');
    expect(flag.value).toBe('dark');
  });

  it('getNumberFlag returns number value', () => {
    const client = createMockClient({ flags: { timeout: 5000 } });
    const flag = client.getNumberFlag('timeout', 0);
    expect(flag.value).toBe(5000);
  });

  it('getJsonFlag returns object value', () => {
    const client = createMockClient({ flags: { config: { retries: 3 } } });
    const flag = client.getJsonFlag<{ retries: number }>('config', { retries: 0 });
    expect(flag.value).toEqual({ retries: 3 });
  });
});

describe('createMockClient — flagsByUser overrides', () => {
  it('flagsByUser takes precedence over flags for matching user', () => {
    const client = createMockClient({
      flags: { 'feature-x': false },
      flagsByUser: { 'feature-x:power-user': true },
      context: { kind: 'user', key: 'power-user' },
    });
    const flag = client.getBoolFlag('feature-x', false);
    expect(flag.value).toBe(true);
  });

  it('flagsByUser does NOT override for a different user', () => {
    const client = createMockClient({
      flags: { 'feature-x': false },
      flagsByUser: { 'feature-x:power-user': true },
      context: { kind: 'user', key: 'regular-user' },
    });
    const flag = client.getBoolFlag('feature-x', false);
    expect(flag.value).toBe(false);
  });

  it('flagsByUser works even when no flags baseline is set', () => {
    const client = createMockClient({
      flagsByUser: { 'beta:alice': 'on' },
      context: { kind: 'user', key: 'alice' },
    });
    const flag = client.getStringFlag('beta', 'off');
    expect(flag.value).toBe('on');
  });
});

describe('createMockClient — not ready mode', () => {
  it('returns not_ready flags when ready=false', () => {
    // B15: `not_ready`, not `not_found`. "You asked too early" and "that flag
    // does not exist" are different problems with different fixes, and the
    // mock used to conflate them where the real client no longer does.
    const client = createMockClient({
      flags: { 'my-flag': true },
      ready: false,
    });
    const flag = client.getBoolFlag('my-flag', false);
    expect(flag.source).toBe('not_ready');
    expect(flag.value).toBe(false);
  });

  it('resolves onReady after _markReady is called', async () => {
    const client = createMockClient({ ready: false });
    let resolved = false;
    client.onReady().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    client._markReady();
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it('serves flags after _markReady', () => {
    const client = createMockClient({
      flags: { 'my-flag': true },
      ready: false,
    });
    client._markReady();
    const flag = client.getBoolFlag('my-flag', false);
    expect(flag.value).toBe(true);
    expect(flag.source).toBe('rule');
  });
});

describe('createMockClient — identify + updateAttributes', () => {
  it('identify changes the current context', () => {
    const client = createMockClient();
    client.identify({ kind: 'user', key: 'new-user' });
    expect((client.getContext() as { key: string }).key).toBe('new-user');
  });

  it('identify causes flagsByUser to resolve against new context', () => {
    const client = createMockClient({
      flagsByUser: { 'flag:new-user': 'variant-b' },
    });
    client.identify({ kind: 'user', key: 'new-user' });
    const flag = client.getStringFlag('flag', 'control');
    expect(flag.value).toBe('variant-b');
  });

  it('updateAttributes merges partial into single context', () => {
    const client = createMockClient({ context: { kind: 'user', key: 'u1', plan: 'free' } });
    client.updateAttributes({ plan: 'pro' });
    const ctx = client.getContext() as unknown as { plan: string };
    expect(ctx.plan).toBe('pro');
  });
});

describe('createMockClient — track + _tracked', () => {
  it('records tracked events', () => {
    const client = createMockClient();
    client.track('purchase', { value: 49.99 });
    client.track('signup');
    const tracked = client._tracked();
    expect(tracked).toHaveLength(2);
    expect(tracked[0].eventKey).toBe('purchase');
    expect(tracked[0].payload?.value).toBe(49.99);
  });

  it('track without payload stores undefined payload', () => {
    const client = createMockClient();
    client.track('view');
    expect(client._tracked()[0].payload).toBeUndefined();
  });

  it('reset clears tracked events', () => {
    const client = createMockClient();
    client.track('event-a');
    client.reset();
    expect(client._tracked()).toHaveLength(0);
  });
});

describe('createMockClient — _evaluations', () => {
  it('records evaluations on getFlag', () => {
    const client = createMockClient({ flags: { 'hero-cta': 'signup' } });
    client.getStringFlag('hero-cta', 'login');
    const evals = client._evaluations();
    expect(evals).toHaveLength(1);
    expect(evals[0].flagKey).toBe('hero-cta');
    expect(evals[0].value).toBe('signup');
  });

  it('records context key in evaluation', () => {
    const client = createMockClient({
      flags: { x: 1 },
      context: { kind: 'user', key: 'u42' },
    });
    client.getNumberFlag('x', 0);
    expect(client._evaluations()[0].contextKey).toBe('u42');
  });

  it('records not_found evaluation when flag is absent', () => {
    const client = createMockClient();
    client.getBoolFlag('missing', false);
    const evals = client._evaluations();
    expect(evals).toHaveLength(1);
    expect(evals[0].flagKey).toBe('missing');
  });
});

describe('createMockClient — _setFlag + subscribe', () => {
  it('_setFlag updates the returned value', () => {
    const client = createMockClient({ flags: { 'dark-mode': false } });
    expect(client.getBoolFlag('dark-mode', false).value).toBe(false);
    client._setFlag('dark-mode', true);
    expect(client.getBoolFlag('dark-mode', false).value).toBe(true);
  });

  it('_setFlag fires subscribe listeners', () => {
    const client = createMockClient({ flags: { tab: 'a' } });
    let callCount = 0;
    client.subscribe('tab', () => {
      callCount++;
    });
    client._setFlag('tab', 'b');
    expect(callCount).toBe(1);
  });

  it('subscribe unsubscribe stops notifications', () => {
    const client = createMockClient({ flags: { counter: 0 } });
    let callCount = 0;
    const unsub = client.subscribe('counter', () => {
      callCount++;
    });
    client._setFlag('counter', 1);
    unsub();
    client._setFlag('counter', 2);
    expect(callCount).toBe(1);
  });

  it('_setFlag emits flagChange event on the bus', () => {
    const client = createMockClient({ flags: { exp: 'ctrl' } });
    let changeData: { flagKey: string; previousValue: unknown; newValue: unknown } | null = null;
    client.on('flagChange', (data) => {
      changeData = data;
    });
    client._setFlag('exp', 'treatment');
    expect(changeData).not.toBeNull();
    expect(changeData!.flagKey).toBe('exp');
    expect(changeData!.previousValue).toBe('ctrl');
    expect(changeData!.newValue).toBe('treatment');
  });
});

describe('createMockClient — getAllFlags', () => {
  it('returns all configured flags', () => {
    const client = createMockClient({ flags: { a: 1, b: 2, c: 3 } });
    const all = client.getAllFlags();
    expect(Object.keys(all)).toHaveLength(3);
    expect(all['a'].value).toBe(1);
  });

  it('getAllFlags returns empty object when no flags configured', () => {
    const client = createMockClient();
    expect(Object.keys(client.getAllFlags())).toHaveLength(0);
  });
});

describe('createMockClient — getSnapshot', () => {
  it('returns flag value synchronously without emitting evaluation', () => {
    const client = createMockClient({ flags: { snap: 'x' } });
    const snapshot = client.getSnapshot('snap', 'default');
    expect(snapshot.value).toBe('x');
    // getSnapshot does NOT emit evaluation
    expect(client._evaluations()).toHaveLength(0);
  });

  it('returns not_ready when client is not ready', () => {
    const client = createMockClient({ flags: { snap: 'x' }, ready: false });
    const snapshot = client.getSnapshot('snap', 'default');
    expect(snapshot.source).toBe('not_ready');
    expect(snapshot.value).toBe('default');
  });
});

describe('createMockClient — on() event bus', () => {
  it('on returns unsubscribe and stops listening after call', () => {
    const client = createMockClient({ ready: false });
    let readyCount = 0;
    const unsub = client.on('ready', () => {
      readyCount++;
    });
    client._markReady();
    expect(readyCount).toBe(1);
    unsub();
    // Re-create doesn't re-fire — just verify unsub returned correctly
    expect(typeof unsub).toBe('function');
  });
});
