/**
 * Module options, their defaults, and the one function that turns what a user
 * wrote in `nuxt.config` into the runtime config the plugin reads.
 *
 * Kept free of `@nuxt/kit` so it is unit-testable without a Nuxt install, and
 * so `src/module.ts` stays a thin wiring file.
 */
import { DEFAULT_CDN_HOST as CORE_DEFAULT_CDN_HOST } from '@avsbhq/core';
import type { AvsbClientRuntimeOptions } from './clientOptions';

/**
 * `avsb: { … }` in `nuxt.config.ts`.
 *
 * ```ts
 * export default defineNuxtConfig({
 *   modules: ['@avsbhq/nuxt'],
 *   avsb: { sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn' },
 * })
 * ```
 */
export interface AvsbModuleOptions {
  /**
   * SDK key for the environment this build targets, shaped
   * `sdk_<environment>_<id>`. Falls back to `NUXT_PUBLIC_AVSB_SDK_KEY`, then
   * `AVSB_SDK_KEY`, from the environment the build (or the server) runs in.
   *
   * The key reaches the browser either way, and that is fine: it is a public
   * identifier. Because it lands in `runtimeConfig.public`, Nuxt lets you
   * override it at deploy time with `NUXT_PUBLIC_AVSB_SDK_KEY` without a
   * rebuild.
   */
  sdkKey?: string;
  /**
   * Fetch the datafile during server rendering and send it to the browser in
   * the payload, so the first paint has real values and the browser makes no
   * request before it. Default true.
   *
   * Turn it off if you would rather keep the HTML small and accept one
   * client-side fetch (and the default values it renders until it lands).
   */
  bootstrap?: boolean;
  /**
   * Auto-import the A vs B composables (`useBoolFlag`, `useTrack`, and the
   * rest) so components use them without an import line. Default true.
   */
  autoImports?: boolean;
  /** CDN base for datafile fetches. Default `https://cdn.avsb.cloud`. */
  cdnHost?: string;
  /** Milliseconds the SSR datafile fetch may take before it is abandoned. Default 3000. */
  bootstrapTimeout?: number;
  /**
   * Milliseconds a server-fetched datafile is reused across requests before it
   * is fetched again. Default 60000. The browser client keeps polling on its
   * own interval, so this only bounds how stale a first paint can be.
   */
  bootstrapMaxAge?: number;
  /** Everything else `AvsbClient` accepts that survives JSON (polling, logging, caching). */
  client?: AvsbClientRuntimeOptions;
}

/** The `runtimeConfig.public.avsb` block the runtime plugin reads. */
export interface AvsbPublicRuntimeConfig {
  sdkKey: string;
  bootstrap: boolean;
  cdnHost: string;
  bootstrapTimeout: number;
  bootstrapMaxAge: number;
  client: AvsbClientRuntimeOptions;
}

export interface ResolvedModuleOptions {
  runtimeConfig: AvsbPublicRuntimeConfig;
  autoImports: boolean;
  /** Set when something is wrong enough that the module must say so out loud. */
  warning: string | null;
}

/**
 * Re-exported from `@avsbhq/core`, never retyped: the endpoint contract has one
 * source of truth, and a second copy of the host here is exactly how a
 * self-hosted deployment ends up half-configured.
 */
export const DEFAULT_CDN_HOST = CORE_DEFAULT_CDN_HOST;
export const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 3000;
export const DEFAULT_BOOTSTRAP_MAX_AGE_MS = 60_000;

export const AVSB_MODULE_DEFAULTS: AvsbModuleOptions = {
  bootstrap: true,
  autoImports: true,
  cdnHost: DEFAULT_CDN_HOST,
  bootstrapTimeout: DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  bootstrapMaxAge: DEFAULT_BOOTSTRAP_MAX_AGE_MS,
};

const MISSING_KEY_WARNING =
  'No SDK key. Set avsb.sdkKey in nuxt.config, or NUXT_PUBLIC_AVSB_SDK_KEY in the ' +
  'environment. The key for each environment is on app.avsb.cloud under Environments ' +
  'in the project sidebar, and looks like "sdk_production_ttqm0eaj4vth1krcb2xn". ' +
  'Until it is set, no A vs B client is created and the composables have nothing to read.';

/** The environment variables this module reads, in priority order. */
export type EnvironmentLike = Record<string, string | undefined>;

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return '';
}

/**
 * Merge user options with defaults and the environment.
 *
 * Pure on purpose: `setup()` in module.ts does nothing but call this, log the
 * warning if there is one, and hand the result to Nuxt.
 */
export function resolveModuleOptions(
  options: AvsbModuleOptions,
  env: EnvironmentLike = {},
): ResolvedModuleOptions {
  const sdkKey = firstNonEmpty(
    options.sdkKey,
    env['NUXT_PUBLIC_AVSB_SDK_KEY'],
    env['AVSB_SDK_KEY'],
  );

  const runtimeConfig: AvsbPublicRuntimeConfig = {
    sdkKey,
    bootstrap: options.bootstrap ?? true,
    cdnHost: firstNonEmpty(options.cdnHost, DEFAULT_CDN_HOST),
    bootstrapTimeout: options.bootstrapTimeout ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
    bootstrapMaxAge: options.bootstrapMaxAge ?? DEFAULT_BOOTSTRAP_MAX_AGE_MS,
    client: options.client ?? {},
  };

  return {
    runtimeConfig,
    autoImports: options.autoImports ?? true,
    warning: sdkKey === '' ? MISSING_KEY_WARNING : null,
  };
}
