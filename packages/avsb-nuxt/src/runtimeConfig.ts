/**
 * Reading `runtimeConfig.public.avsb` back out at runtime.
 *
 * The module writes it, so it should always be there and always be the right
 * shape. "Should" is doing a lot of work in a config object that can be
 * overridden by environment variables at deploy time (`NUXT_PUBLIC_AVSB_*`,
 * which arrive as strings), so the plugin narrows it with guards instead of
 * asserting, and unknown values fall back to the documented defaults rather
 * than reaching the SDK.
 */
import type { AvsbClientRuntimeOptions } from './clientOptions';
import type { AvsbPublicRuntimeConfig } from './options';
import {
  DEFAULT_BOOTSTRAP_MAX_AGE_MS,
  DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  DEFAULT_CDN_HOST,
} from './options';

const NUMBER_KEYS = [
  'pollingInterval',
  'initTimeout',
  'cacheMaxAgeMs',
  'maxPendingEvents',
] as const;

const BOOLEAN_KEYS = [
  'autoRefresh',
  'cache',
  'adoptSnippetVisitorId',
  'pauseWhenHidden',
  'refetchOnFocus',
  'streaming',
] as const;

const STRING_KEYS = ['cdnHost', 'streamingEndpoint'] as const;

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;

type LogLevelValue = (typeof LOG_LEVELS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLogLevel(value: unknown): value is LogLevelValue {
  return typeof value === 'string' && LOG_LEVELS.some((level) => level === value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Environment overrides arrive as strings: NUXT_PUBLIC_AVSB_BOOTSTRAP_MAX_AGE=30000.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * Copy the client options the SDK understands, dropping anything unrecognised.
 *
 * Field by field rather than a cast: this object is handed straight to
 * `AvsbClient`, and a stray string where a number belongs would be a confusing
 * runtime failure well away from the config file that caused it.
 */
export function readClientRuntimeOptions(value: unknown): AvsbClientRuntimeOptions {
  if (!isRecord(value)) return {};

  const options: AvsbClientRuntimeOptions = {};

  for (const key of NUMBER_KEYS) {
    const raw = value[key];
    if (raw === undefined) continue;
    const parsed = readNumber(raw, Number.NaN);
    if (Number.isFinite(parsed)) options[key] = parsed;
  }

  for (const key of BOOLEAN_KEYS) {
    const raw = value[key];
    if (raw === undefined) continue;
    if (typeof raw === 'boolean' || raw === 'true' || raw === 'false') {
      options[key] = readBoolean(raw, false);
    }
  }

  for (const key of STRING_KEYS) {
    const raw = value[key];
    if (typeof raw === 'string' && raw.length > 0) options[key] = raw;
  }

  if (isLogLevel(value['logLevel'])) options.logLevel = value['logLevel'];

  return options;
}

/**
 * Narrow `runtimeConfig.public.avsb` to the config the plugin needs.
 *
 * Returns null when there is no usable SDK key, which is the one condition the
 * plugin cannot work around: without a key there is no client to create.
 */
export function readAvsbPublicConfig(value: unknown): AvsbPublicRuntimeConfig | null {
  if (!isRecord(value)) return null;

  const sdkKey = readString(value['sdkKey'], '');
  if (sdkKey === '') return null;

  return {
    sdkKey,
    bootstrap: readBoolean(value['bootstrap'], true),
    cdnHost: readString(value['cdnHost'], DEFAULT_CDN_HOST),
    bootstrapTimeout: readNumber(value['bootstrapTimeout'], DEFAULT_BOOTSTRAP_TIMEOUT_MS),
    bootstrapMaxAge: readNumber(value['bootstrapMaxAge'], DEFAULT_BOOTSTRAP_MAX_AGE_MS),
    client: readClientRuntimeOptions(value['client']),
  };
}
