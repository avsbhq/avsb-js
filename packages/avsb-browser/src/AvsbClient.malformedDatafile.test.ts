// N0-15 (production QA 2026-10-01): a malformed datafile handed to the SDK
// made the first flag read throw from inside the evaluator, although reads
// are documented never to throw. The browser client now refuses one at
// every entry point, naming the broken field, and keeps answering.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FlagDatafile, Logger } from '@avsbhq/core';
import { AvsbClient } from './AvsbClient';
import { acceptDatafile, malformedDatafileMessage } from './datafileGuard';

const SDK_KEY = 'sdk_production_browsermalformed1';

function goodDatafile(): FlagDatafile {
  return {
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
        defaultVariationId: 'var_off',
        variations: [
          { id: 'var_off', key: 'off', value: false },
          { id: 'var_on', key: 'on', value: true },
        ],
        overrides: [],
        rules: [
          {
            id: 'rule_1',
            type: 'targeted_delivery',
            enabled: true,
            audienceIds: [],
            hashAttribute: 'user.key',
            trafficAllocation: null,
            variations: [{ variationId: 'var_on', percentage: 1 }],
          },
        ],
      },
    ],
    audiences: [],
  };
}

const MALFORMED = { flags: {}, audiences: [] } as unknown as FlagDatafile;

function recordingLogger(): Logger & { errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (message: string) => {
      errors.push(message);
    },
    child() {
      return this;
    },
  };
}

const clients: AvsbClient[] = [];
function makeClient(options: {
  bootstrap?: FlagDatafile;
  logger: Logger;
  autoInit?: boolean;
}): AvsbClient {
  const client = new AvsbClient({
    sdkKey: SDK_KEY,
    context: { kind: 'user', key: 'u1' },
    cache: false,
    autoRefresh: false,
    autoInit: options.autoInit ?? false,
    bootstrap: options.bootstrap,
    logger: options.logger,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  vi.unstubAllGlobals();
});

describe('a malformed bootstrap datafile', () => {
  it('is refused, so typed and untyped reads answer not_ready instead of throwing', () => {
    const logger = recordingLogger();
    const client = makeClient({ bootstrap: MALFORMED, logger });

    expect(() => client.getBoolFlag('checkout_v2', true)).not.toThrow();
    expect(client.getBoolFlag('checkout_v2', true).source).toBe('not_ready');
    expect(client.getFlag('checkout_v2', 'x').value).toBe('x');
    expect(client.isReady()).toBe(false);
  });

  it('logs one error naming the broken field and the constructor', () => {
    const logger = recordingLogger();
    makeClient({ bootstrap: MALFORMED, logger });

    expect(logger.errors).toEqual([
      malformedDatafileMessage('bootstrap', 'datafile.flags is an object, expected an array'),
    ]);
  });
});

describe('applyDatafileBootstrap with a malformed datafile', () => {
  it('keeps serving the datafile the client already had', () => {
    const logger = recordingLogger();
    const client = makeClient({ bootstrap: goodDatafile(), logger });

    client.applyDatafileBootstrap(MALFORMED);

    expect(client.getBoolFlag('checkout_v2', false).value).toBe(true);
    expect(logger.errors[0]).toContain('applyDatafileBootstrap()');
  });
});

describe('a network response that is JSON but not a datafile', () => {
  it('fails init with a message naming the host and the broken field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ flags: 'nope' }), { status: 200 })),
    );
    const logger = recordingLogger();
    const client = makeClient({ logger, autoInit: true });

    const result = await client.onReady();

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('datafile.flags is a string, expected an array');
    expect(client.getBoolFlag('checkout_v2', false).source).toBe('not_ready');
  });
});

describe('acceptDatafile', () => {
  it('passes a readable datafile through and logs nothing', () => {
    const logger = recordingLogger();
    const datafile = goodDatafile();
    expect(acceptDatafile(datafile, 'bootstrap', logger)).toBe(datafile);
    expect(logger.errors).toEqual([]);
  });

  it('refuses a datafile whose rule is missing its audience list', () => {
    const logger = recordingLogger();
    const broken = goodDatafile() as unknown as { flags: Array<{ rules: Array<Record<string, unknown>> }> };
    delete broken.flags[0].rules[0].audienceIds;

    expect(acceptDatafile(broken, 'applyDatafileBootstrap', logger)).toBeNull();
    expect(logger.errors[0]).toContain('datafile.flags[0].rules[0].audienceIds is missing');
  });
});
