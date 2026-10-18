import { describe, expect, it } from 'vitest';
import type { EvalContext, FlagDatafile } from '@avsbhq/core';
import type { AvsbClientRuntimeOptions } from './clientOptions';
import { buildAvsbClientOptions } from './clientOptions';
import { SDK_VERSION } from './version';

const DATAFILE: FlagDatafile = {
  version: 2,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk_production_abc123',
  environmentKey: 'production',
  publishedAt: '2026-01-01T00:00:00.000Z',
  collectEndpoint: 'https://events.avsb.cloud',
  flags: [],
  audiences: [],
};

const CONTEXT: EvalContext = { kind: 'user', key: 'u_1' };

describe('buildAvsbClientOptions', () => {
  it('gives the server client no network, no timers and no storage', () => {
    const options = buildAvsbClientOptions({
      sdkKey: 'sdk_production_abc123',
      isServer: true,
      bootstrap: DATAFILE,
    });

    expect(options.autoInit).toBe(false);
    expect(options.autoRefresh).toBe(false);
    expect(options.cache).toBe(false);
    expect(options.streaming).toBe(false);
    expect(options.bootstrap).toBe(DATAFILE);
  });

  it('leaves the browser SDK defaults untouched in the browser', () => {
    const options = buildAvsbClientOptions({
      sdkKey: 'sdk_production_abc123',
      isServer: false,
      bootstrap: DATAFILE,
    });

    expect(options.autoInit).toBeUndefined();
    expect(options.autoRefresh).toBeUndefined();
    expect(options.cache).toBeUndefined();
    expect(options.streaming).toBeUndefined();
  });

  it('omits bootstrap and context entirely when there are none', () => {
    const options = buildAvsbClientOptions({
      sdkKey: 'sdk_production_abc123',
      isServer: false,
      bootstrap: null,
      context: null,
    });

    expect('bootstrap' in options).toBe(false);
    expect('context' in options).toBe(false);
    expect(options.sdkKey).toBe('sdk_production_abc123');
  });

  it('passes the evaluation context through', () => {
    const options = buildAvsbClientOptions({
      sdkKey: 'sdk_production_abc123',
      isServer: false,
      context: CONTEXT,
    });

    expect(options.context).toEqual(CONTEXT);
  });

  it('carries the client bag but never lets it override the SDK key', () => {
    // A key in the wrong place is a real mistake to make in a config file.
    const bagWithStrayKey: AvsbClientRuntimeOptions & Record<string, unknown> = {
      pollingInterval: 30_000,
      logLevel: 'debug',
      sdkKey: 'sdk_production_wrong',
    };

    const options = buildAvsbClientOptions({
      sdkKey: 'sdk_production_real',
      isServer: false,
      client: bagWithStrayKey,
    });

    expect(options.sdkKey).toBe('sdk_production_real');
    expect(options.pollingInterval).toBe(30_000);
    expect(options.logLevel).toBe('debug');
  });

  it('never lets the app turn polling or streaming back on during a server render', () => {
    const options = buildAvsbClientOptions({
      sdkKey: 'sdk_production_abc123',
      isServer: true,
      client: { autoRefresh: true, streaming: true, cache: true },
    });

    expect(options.autoRefresh).toBe(false);
    expect(options.streaming).toBe(false);
    expect(options.cache).toBe(false);
  });

  it('uses the module cdnHost only when the client bag did not set one', () => {
    expect(
      buildAvsbClientOptions({
        sdkKey: 'sdk_production_abc123',
        isServer: false,
        cdnHost: 'https://cdn.module.example',
      }).cdnHost,
    ).toBe('https://cdn.module.example');

    expect(
      buildAvsbClientOptions({
        sdkKey: 'sdk_production_abc123',
        isServer: false,
        cdnHost: 'https://cdn.module.example',
        client: { cdnHost: 'https://cdn.client.example' },
      }).cdnHost,
    ).toBe('https://cdn.client.example');
  });
});

// N1-14: the heartbeat names @avsbhq/nuxt, not the vue or browser package
// underneath it. The vue plugin keeps an identity it is handed (tested in
// @avsbhq/vue), so the options are where nuxt names itself.
describe('buildAvsbClientOptions: SDK identity', () => {
  it('names @avsbhq/nuxt at its package.json version on the server and in the browser', () => {
    for (const isServer of [true, false]) {
      const options = buildAvsbClientOptions({ sdkKey: 'sdk_production_abc123', isServer });
      expect(options.wrapper).toEqual({ sdkType: '@avsbhq/nuxt', sdkVersion: SDK_VERSION });
    }
  });

  it('cannot be relabelled through avsb.client in nuxt.config', () => {
    const options = buildAvsbClientOptions({
      sdkKey: 'sdk_production_abc123',
      isServer: false,
      client: { logLevel: 'silent' },
    });
    expect(options.wrapper?.sdkType).toBe('@avsbhq/nuxt');
  });
});
