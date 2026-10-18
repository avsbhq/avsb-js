import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOOTSTRAP_MAX_AGE_MS,
  DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  DEFAULT_CDN_HOST,
} from './options';
import { readAvsbPublicConfig, readClientRuntimeOptions } from './runtimeConfig';

describe('readAvsbPublicConfig', () => {
  it('reads the block the module wrote', () => {
    expect(
      readAvsbPublicConfig({
        sdkKey: 'sdk_production_abc123',
        bootstrap: false,
        cdnHost: 'https://cdn.example.com',
        bootstrapTimeout: 750,
        bootstrapMaxAge: 5000,
        client: { pollingInterval: 30_000 },
      }),
    ).toEqual({
      sdkKey: 'sdk_production_abc123',
      bootstrap: false,
      cdnHost: 'https://cdn.example.com',
      bootstrapTimeout: 750,
      bootstrapMaxAge: 5000,
      client: { pollingInterval: 30_000 },
    });
  });

  it('returns null when there is no usable key, which is the one thing it cannot work around', () => {
    expect(readAvsbPublicConfig(undefined)).toBeNull();
    expect(readAvsbPublicConfig(null)).toBeNull();
    expect(readAvsbPublicConfig('sdk_production_abc123')).toBeNull();
    expect(readAvsbPublicConfig([])).toBeNull();
    expect(readAvsbPublicConfig({})).toBeNull();
    expect(readAvsbPublicConfig({ sdkKey: '' })).toBeNull();
    expect(readAvsbPublicConfig({ sdkKey: 42 })).toBeNull();
  });

  it('accepts the string forms environment overrides arrive as', () => {
    // NUXT_PUBLIC_AVSB_BOOTSTRAP=false, NUXT_PUBLIC_AVSB_BOOTSTRAP_MAX_AGE=30000
    const config = readAvsbPublicConfig({
      sdkKey: 'sdk_production_abc123',
      bootstrap: 'false',
      bootstrapMaxAge: '30000',
    });

    expect(config?.bootstrap).toBe(false);
    expect(config?.bootstrapMaxAge).toBe(30_000);
  });

  it('falls back to the documented defaults for anything unusable', () => {
    const config = readAvsbPublicConfig({
      sdkKey: 'sdk_production_abc123',
      bootstrap: 'maybe',
      cdnHost: '',
      bootstrapTimeout: 'soon',
      bootstrapMaxAge: {},
      client: 'nonsense',
    });

    expect(config).toEqual({
      sdkKey: 'sdk_production_abc123',
      bootstrap: true,
      cdnHost: DEFAULT_CDN_HOST,
      bootstrapTimeout: DEFAULT_BOOTSTRAP_TIMEOUT_MS,
      bootstrapMaxAge: DEFAULT_BOOTSTRAP_MAX_AGE_MS,
      client: {},
    });
  });
});

describe('readClientRuntimeOptions', () => {
  it('keeps every field the SDK understands', () => {
    expect(
      readClientRuntimeOptions({
        pollingInterval: 30_000,
        initTimeout: 2000,
        cacheMaxAgeMs: 60_000,
        maxPendingEvents: 50,
        autoRefresh: false,
        cache: true,
        adoptSnippetVisitorId: false,
        pauseWhenHidden: true,
        refetchOnFocus: false,
        streaming: true,
        cdnHost: 'https://cdn.example.com',
        streamingEndpoint: 'https://stream.example.com/ticket',
        logLevel: 'debug',
      }),
    ).toEqual({
      pollingInterval: 30_000,
      initTimeout: 2000,
      cacheMaxAgeMs: 60_000,
      maxPendingEvents: 50,
      autoRefresh: false,
      cache: true,
      adoptSnippetVisitorId: false,
      pauseWhenHidden: true,
      refetchOnFocus: false,
      streaming: true,
      cdnHost: 'https://cdn.example.com',
      streamingEndpoint: 'https://stream.example.com/ticket',
      logLevel: 'debug',
    });
  });

  it('drops values of the wrong shape instead of handing them to the SDK', () => {
    expect(
      readClientRuntimeOptions({
        pollingInterval: 'often',
        autoRefresh: 'yes',
        logLevel: 'chatty',
        cdnHost: 42,
        unknownOption: true,
      }),
    ).toEqual({});
  });

  it('parses the numbers and booleans an environment override turns into strings', () => {
    expect(
      readClientRuntimeOptions({
        pollingInterval: '30000',
        autoRefresh: 'false',
        streaming: 'true',
      }),
    ).toEqual({
      pollingInterval: 30_000,
      autoRefresh: false,
      streaming: true,
    });
  });

  it('is empty for anything that is not an object', () => {
    expect(readClientRuntimeOptions(undefined)).toEqual({});
    expect(readClientRuntimeOptions(null)).toEqual({});
    expect(readClientRuntimeOptions(['pollingInterval'])).toEqual({});
  });
});
