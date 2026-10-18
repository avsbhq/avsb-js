/**
 * What the Flags SDK actually gets back.
 *
 * Every test drives `decide` the way `flag()` does: a key, whatever `identify`
 * returned as entities, the request's cookies, and the declaration's default
 * value. The evaluator underneath is a stand-in that records what it was asked,
 * so these assert the handoff (context, defaults, exposure suppression,
 * one client for many decisions), not the evaluator, which has its own suite.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { DecideOption, createFlag } from '@avsbhq/core';
import type { EvalContext, Flag, InitResult, Logger } from '@avsbhq/core';
import { createAvsbAdapter } from './adapter';
import type { AvsbEvaluator, CookiesLike, ServerReadOptions } from './types';

const USER: EvalContext = { kind: 'user', key: 'u_1' };

interface RecordedRead {
  flagKey: string;
  defaultValue: unknown;
  context: EvalContext | undefined;
  options: ServerReadOptions | undefined;
}

function decidedFlag<T>(value: T, variationKey: string | null): Flag<T> {
  return createFlag<T>({
    value,
    variationKey,
    source: variationKey === null ? 'default' : 'rule',
    ruleId: variationKey === null ? null : 'r_1',
    ruleType: variationKey === null ? null : 'ab_test',
    reasons: [],
  });
}

function fakeEvaluator(overrides?: {
  initResult?: InitResult;
  boolValue?: boolean;
  stringValue?: string;
  numberValue?: number;
  jsonValue?: unknown;
  variationKey?: string | null;
}) {
  const reads: RecordedRead[] = [];
  const record = (
    flagKey: string,
    defaultValue: unknown,
    context: EvalContext | undefined,
    options: ServerReadOptions | undefined,
  ): void => {
    reads.push({ flagKey, defaultValue, context, options });
  };

  const close = vi.fn(async () => undefined);

  const client: AvsbEvaluator = {
    onReady: async () => overrides?.initResult ?? { success: true, source: 'network' },
    getBoolFlag: (flagKey, defaultValue, context, options) => {
      record(flagKey, defaultValue, context, options);
      return decidedFlag(overrides?.boolValue ?? true, 'on');
    },
    getStringFlag: (flagKey, defaultValue, context, options) => {
      record(flagKey, defaultValue, context, options);
      return decidedFlag(overrides?.stringValue ?? 'blue', 'blue');
    },
    getNumberFlag: (flagKey, defaultValue, context, options) => {
      record(flagKey, defaultValue, context, options);
      return decidedFlag(overrides?.numberValue ?? 42, 'high');
    },
    getJsonFlag: <T>(
      flagKey: string,
      defaultValue: T,
      context?: EvalContext,
      options?: ServerReadOptions,
    ): Flag<T> => {
      record(flagKey, defaultValue, context, options);
      // The stand-in value is declared as `unknown` because one fixture serves
      // every T; the test that uses it asserts the shape it passed in.
      const value = (overrides?.jsonValue ?? defaultValue) as T;
      return decidedFlag<T>(value, 'variant');
    },
    getFlag: <T>(
      flagKey: string,
      defaultValue: T,
      context?: EvalContext,
      options?: ServerReadOptions,
    ): Flag<T> => {
      record(flagKey, defaultValue, context, options);
      const variationKey = overrides?.variationKey === undefined ? 'on' : overrides.variationKey;
      return decidedFlag<T>(defaultValue, variationKey);
    },
    close,
  };

  return { client, reads, close };
}

function testLogger() {
  // Typed with the method's own signature: a bare `vi.fn()` is
  // `Mock<Procedure | Constructable>` and satisfies neither half of the
  // intersection.
  const logger: Logger & { error: Mock<Logger['error']> } = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn<Logger['error']>(),
    child: () => logger,
  };
  return logger;
}

function cookies(jar: Record<string, string>): CookiesLike {
  return {
    get: (name) => {
      const value = jar[name];
      return value === undefined ? undefined : { value };
    },
  };
}

describe('createAvsbAdapter typed adapters', () => {
  it('evaluates a boolean flag for the context identify() returned', async () => {
    const { client, reads } = fakeEvaluator({ boolValue: true });
    const adapter = createAvsbAdapter({ client }).booleanValue();

    const value = await adapter.decide({
      key: 'new-checkout-flow',
      entities: USER,
      defaultValue: false,
    });

    expect(value).toBe(true);
    expect(reads).toEqual([
      {
        flagKey: 'new-checkout-flow',
        defaultValue: false,
        context: USER,
        options: {},
      },
    ]);
  });

  it('routes each typed adapter to its own getter', async () => {
    const { client, reads } = fakeEvaluator({
      stringValue: 'blue',
      numberValue: 42,
      jsonValue: { theme: 'dark' },
    });
    const adapter = createAvsbAdapter({ client });

    expect(await adapter.stringValue().decide({ key: 'button-colour', entities: USER })).toBe(
      'blue',
    );
    expect(await adapter.numberValue().decide({ key: 'page-size', entities: USER })).toBe(42);
    expect(
      await adapter
        .jsonValue<{ theme: string }>({ theme: 'light' })
        .decide({ key: 'ui-config', entities: USER }),
    ).toEqual({ theme: 'dark' });

    expect(reads.map((read) => read.flagKey)).toEqual(['button-colour', 'page-size', 'ui-config']);
  });

  it('falls back to the empty value for the type when a declaration set no default', async () => {
    const { client, reads } = fakeEvaluator();
    const adapter = createAvsbAdapter({ client });

    await adapter.booleanValue().decide({ key: 'a', entities: USER });
    await adapter.stringValue().decide({ key: 'b', entities: USER });
    await adapter.numberValue().decide({ key: 'c', entities: USER });

    expect(reads.map((read) => read.defaultValue)).toEqual([false, '', 0]);
  });

  it('reports the variation key, and the declared default when nothing was decided', async () => {
    const decided = fakeEvaluator({ variationKey: 'treatment' });
    expect(
      await createAvsbAdapter({ client: decided.client })
        .variationKey()
        .decide({ key: 'pricing-test', entities: USER }),
    ).toBe('treatment');

    const undecided = fakeEvaluator({ variationKey: null });
    expect(
      await createAvsbAdapter({ client: undecided.client })
        .variationKey()
        .decide({ key: 'pricing-test', entities: USER, defaultValue: 'control' }),
    ).toBe('control');
  });
});

describe('createAvsbAdapter exposures', () => {
  it('records an exposure per decision by default', async () => {
    const { client, reads } = fakeEvaluator();
    await createAvsbAdapter({ client })
      .booleanValue()
      .decide({ key: 'new-checkout-flow', entities: USER });

    expect(reads[0]?.options).toEqual({});
  });

  it('suppresses exposures when asked', async () => {
    const { client, reads } = fakeEvaluator();
    await createAvsbAdapter({ client, exposure: 'off' })
      .booleanValue()
      .decide({ key: 'new-checkout-flow', entities: USER });

    expect(reads[0]?.options).toEqual({
      decideOptions: [DecideOption.DISABLE_EXPOSURE],
    });
  });
});

describe('createAvsbAdapter identity', () => {
  it('falls back to the anonymous visitor cookie when a flag has no identify', async () => {
    const { client, reads } = fakeEvaluator();
    await createAvsbAdapter({ client })
      .booleanValue()
      .decide({
        key: 'new-checkout-flow',
        cookies: cookies({ avsb_anon_id: 'anon_9' }),
      });

    expect(reads[0]?.context).toEqual({ kind: 'user', key: 'anon_9' });
  });

  it('returns the default without evaluating when nobody can be identified', async () => {
    const { client, reads } = fakeEvaluator({ boolValue: true });
    const logger = testLogger();

    const value = await createAvsbAdapter({ client, logger })
      .booleanValue()
      .decide({
        key: 'new-checkout-flow',
        cookies: cookies({}),
        defaultValue: false,
      });

    expect(value).toBe(false);
    expect(reads).toEqual([]);
  });
});

describe('createAvsbAdapter client lifecycle', () => {
  it('creates the client once, however many decisions are made', async () => {
    const { client } = fakeEvaluator();
    const factory = vi.fn(() => client);
    const adapter = createAvsbAdapter({ client: factory });

    await Promise.all([
      adapter.booleanValue().decide({ key: 'a', entities: USER }),
      adapter.booleanValue().decide({ key: 'b', entities: USER }),
      adapter.stringValue().decide({ key: 'c', entities: USER }),
    ]);

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('initialize() on one typed adapter warms the client for all of them', async () => {
    const { client } = fakeEvaluator();
    const factory = vi.fn(() => client);
    const adapter = createAvsbAdapter({ client: factory });

    const boolAdapter = adapter.booleanValue();
    await boolAdapter.initialize?.();
    await adapter.stringValue().decide({ key: 'c', entities: USER });

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('never throws when the client cannot be built: it logs and serves defaults', async () => {
    const logger = testLogger();
    const adapter = createAvsbAdapter({
      client: () => {
        throw new Error('no SDK key');
      },
      logger,
    });

    const value = await adapter
      .booleanValue()
      .decide({ key: 'new-checkout-flow', entities: USER, defaultValue: false });

    expect(value).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0]?.[0])).toContain('no SDK key');
  });

  it('logs once when the datafile never loaded, and still answers with defaults', async () => {
    const logger = testLogger();
    const { client } = fakeEvaluator({
      initResult: {
        success: false,
        source: 'error',
        error: new Error('HTTP 404 for https://cdn.avsb.cloud/sdk_x/datafile.json'),
      },
    });
    const adapter = createAvsbAdapter({ client, logger });

    await adapter.booleanValue().decide({ key: 'a', entities: USER });
    await adapter.booleanValue().decide({ key: 'b', entities: USER });

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0]?.[0])).toContain('HTTP 404');
  });

  it('exposes the client and closes it', async () => {
    const { client, close } = fakeEvaluator();
    const adapter = createAvsbAdapter({ client });

    expect(await adapter.avsbClient()).toBe(client);
    await adapter.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes nothing when no decision was ever made', async () => {
    const { client, close } = fakeEvaluator();
    const factory = vi.fn(() => client);

    await createAvsbAdapter({ client: factory }).close();

    expect(factory).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});

describe('createAvsbAdapter origin', () => {
  it('carries an origin through when one is configured', () => {
    const { client } = fakeEvaluator();
    const origin = (flagKey: string): string => `https://app.avsb.cloud/flags/${flagKey}`;

    expect(createAvsbAdapter({ client, origin }).booleanValue().origin).toBe(origin);
  });

  it('omits origin entirely when there is none, rather than inventing a link', () => {
    const { client } = fakeEvaluator();
    expect('origin' in createAvsbAdapter({ client }).booleanValue()).toBe(false);
  });
});
