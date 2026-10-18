// N1-15 and N1-16 (production QA 2026-10-01).
//
// N1-15: a typed read of a key the datafile does not carry logged "was read
// with the boolean getter but the flag is not a boolean flag (flag declared
// as "boolean" was not found in the datafile)" on EVERY read: 400 identical
// lines for 400 reads, worded like a type mismatch. A missing key is now
// reported once per key, as missing, with the platform spelling suggested
// for a hyphenated key (N1-9); a real type mismatch is reported once per key
// and getter.
//
// N1-16: with a server snapshot adopted and no datafile yet, a key the
// snapshot does not carry read `not_ready`, then `not_found` after
// hydration. It is `not_found` from the start now.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlag } from '@avsbhq/core';
import type { FlagDatafile, Logger } from '@avsbhq/core';
import { AvsbClient } from './AvsbClient';

const SDK_KEY = 'sdk_production_missingkeytest01';

function datafile(): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
    publishedAt: '2026-10-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.test.invalid',
    flags: [
      {
        id: 'flag_copy',
        key: 'hero_copy',
        type: 'string',
        enabled: true,
        defaultVariationId: 'var_a',
        variations: [{ id: 'var_a', key: 'a', value: 'Buy now' }],
        overrides: [],
        rules: [],
      },
    ],
    audiences: [],
  };
}

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message: string) => {
      warnings.push(message);
    },
    error: vi.fn(),
    child() {
      return this;
    },
  };
}

const clients: AvsbClient[] = [];
function makeClient(logger: Logger, withDatafile = true): AvsbClient {
  const client = new AvsbClient({
    sdkKey: SDK_KEY,
    context: { kind: 'user', key: 'u1' },
    bootstrap: withDatafile ? datafile() : undefined,
    autoInit: false,
    autoRefresh: false,
    cache: false,
    logger,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe('a typed read of a key the datafile does not carry (N1-15)', () => {
  it('warns once for 400 reads, as a missing key, and returns the default', () => {
    const logger = recordingLogger();
    const client = makeClient(logger);

    let last = client.getBoolFlag('qa_sdk_missing', true);
    for (let i = 0; i < 399; i++) last = client.getBoolFlag('qa_sdk_missing', true);

    expect(last.value).toBe(true);
    expect(last.source).toBe('not_found');
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain('"qa_sdk_missing" is not in this environment\'s datafile');
    expect(logger.warnings[0]).not.toMatch(/getter|is not a boolean flag/);
  });

  it('shares one warning across the typed, untyped and render-safe read paths', () => {
    const logger = recordingLogger();
    const client = makeClient(logger);

    client.getFlag('qa_sdk_missing', 'x');
    client.getStringFlag('qa_sdk_missing', 'x');
    client.getNumberFlag('qa_sdk_missing', 1, { readOnly: true });
    client.getSnapshot('qa_sdk_missing', false);

    expect(logger.warnings).toHaveLength(1);
  });

  it('suggests the platform spelling for a hyphenated key from an old example (N1-9)', () => {
    const logger = recordingLogger();
    const client = makeClient(logger);

    client.getBoolFlag('new-checkout-flow', false);

    expect(logger.warnings[0]).toContain('did you mean "new_checkout_flow"?');
  });
});

describe('a typed read whose getter does not match the flag type', () => {
  it('still reports the mismatch, once per key and getter', () => {
    const logger = recordingLogger();
    const client = makeClient(logger);

    for (let i = 0; i < 50; i++) client.getBoolFlag('hero_copy', false);
    client.getNumberFlag('hero_copy', 0);

    expect(client.getBoolFlag('hero_copy', false).source).toBe('not_found');
    expect(logger.warnings).toHaveLength(2);
    expect(logger.warnings[0]).toContain('was read with the boolean getter');
    expect(logger.warnings[1]).toContain('was read with the number getter');
  });

  it('logs nothing when the getter matches', () => {
    const logger = recordingLogger();
    const client = makeClient(logger);

    expect(client.getStringFlag('hero_copy', '').value).toBe('Buy now');
    expect(logger.warnings).toEqual([]);
  });
});

describe('a server snapshot without the key (N1-16)', () => {
  it('answers not_found, not not_ready, before any datafile loads', () => {
    const logger = recordingLogger();
    const client = makeClient(logger, false);
    client.applySnapshot({
      capturedAt: 1_700_000_000_000,
      datafileVersion: '2026-10-01T00:00:00.000Z',
      flags: {
        hero_copy: createFlag<unknown>({
          value: 'Buy now',
          variationKey: 'a',
          source: 'default',
          ruleId: null,
          ruleType: null,
          reasons: [],
        }),
      },
      contextSummary: [{ kind: 'user', key: 'u1' }],
    });

    const flag = client.getBoolFlag('qa_sdk_missing', true);

    expect(flag.source).toBe('not_found');
    expect(flag.value).toBe(true);
    expect(client.getStringFlag('hero_copy', '').value).toBe('Buy now');
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain('is not in the server bootstrap snapshot');
  });
});
