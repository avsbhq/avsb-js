import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOOTSTRAP_MAX_AGE_MS,
  DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  DEFAULT_CDN_HOST,
  resolveModuleOptions,
} from './options';

describe('resolveModuleOptions', () => {
  it('fills every runtime-config field from the defaults when only a key is given', () => {
    const resolved = resolveModuleOptions({ sdkKey: 'sdk_production_abc123' });

    expect(resolved.runtimeConfig).toEqual({
      sdkKey: 'sdk_production_abc123',
      bootstrap: true,
      cdnHost: DEFAULT_CDN_HOST,
      bootstrapTimeout: DEFAULT_BOOTSTRAP_TIMEOUT_MS,
      bootstrapMaxAge: DEFAULT_BOOTSTRAP_MAX_AGE_MS,
      client: {},
    });
    expect(resolved.autoImports).toBe(true);
    expect(resolved.warning).toBeNull();
  });

  it('prefers the configured key over both environment variables', () => {
    const resolved = resolveModuleOptions(
      { sdkKey: 'sdk_production_fromconfig' },
      {
        NUXT_PUBLIC_AVSB_SDK_KEY: 'sdk_production_fromnuxtenv',
        AVSB_SDK_KEY: 'sdk_production_fromenv',
      },
    );

    expect(resolved.runtimeConfig.sdkKey).toBe('sdk_production_fromconfig');
  });

  it('falls back to NUXT_PUBLIC_AVSB_SDK_KEY, then AVSB_SDK_KEY', () => {
    expect(
      resolveModuleOptions(
        {},
        {
          NUXT_PUBLIC_AVSB_SDK_KEY: 'sdk_production_fromnuxtenv',
          AVSB_SDK_KEY: 'sdk_production_fromenv',
        },
      ).runtimeConfig.sdkKey,
    ).toBe('sdk_production_fromnuxtenv');

    expect(
      resolveModuleOptions({}, { AVSB_SDK_KEY: 'sdk_production_fromenv' }).runtimeConfig.sdkKey,
    ).toBe('sdk_production_fromenv');
  });

  it('treats a blank or whitespace-only key as no key at all, and trims the rest', () => {
    expect(
      resolveModuleOptions({ sdkKey: '   ' }, { AVSB_SDK_KEY: 'sdk_production_env' }).runtimeConfig
        .sdkKey,
    ).toBe('sdk_production_env');

    expect(resolveModuleOptions({ sdkKey: '  sdk_production_padded  ' }).runtimeConfig.sdkKey).toBe(
      'sdk_production_padded',
    );
  });

  it('warns with the fix when no key is found anywhere', () => {
    const resolved = resolveModuleOptions({}, {});

    expect(resolved.runtimeConfig.sdkKey).toBe('');
    expect(resolved.warning).toContain('avsb.sdkKey in nuxt.config');
    expect(resolved.warning).toContain('NUXT_PUBLIC_AVSB_SDK_KEY');
    // Environments is a top-level sidebar item, not a tab inside Settings. The
    // warning said "Settings, then Environments" and this assertion happily
    // passed on the wrong half of it.
    expect(resolved.warning).toContain('Environments in the project sidebar');
    expect(resolved.warning).not.toContain('Settings, then Environments');
  });

  it('keeps explicit false values instead of defaulting them back on', () => {
    const resolved = resolveModuleOptions({
      sdkKey: 'sdk_production_abc123',
      bootstrap: false,
      autoImports: false,
    });

    expect(resolved.runtimeConfig.bootstrap).toBe(false);
    expect(resolved.autoImports).toBe(false);
  });

  it('carries the client bag and custom timings through untouched', () => {
    const resolved = resolveModuleOptions({
      sdkKey: 'sdk_production_abc123',
      cdnHost: 'https://cdn.example.com',
      bootstrapTimeout: 750,
      bootstrapMaxAge: 5000,
      client: { pollingInterval: 30_000, logLevel: 'debug' },
    });

    expect(resolved.runtimeConfig.cdnHost).toBe('https://cdn.example.com');
    expect(resolved.runtimeConfig.bootstrapTimeout).toBe(750);
    expect(resolved.runtimeConfig.bootstrapMaxAge).toBe(5000);
    expect(resolved.runtimeConfig.client).toEqual({
      pollingInterval: 30_000,
      logLevel: 'debug',
    });
  });

  it('accepts a zero timeout rather than replacing it with the default', () => {
    // `?? default` and `|| default` differ here, and 0 is a legitimate value
    // for "do not wait", so this pins the operator.
    expect(
      resolveModuleOptions({ sdkKey: 'sdk_production_abc123', bootstrapTimeout: 0 }).runtimeConfig
        .bootstrapTimeout,
    ).toBe(0);
  });
});
