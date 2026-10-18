// =====================================================================
// Shared test fixtures.
//
// Not reachable from any package entry point (see tsup.config.ts), so this
// file is type-checked with the package and never shipped in dist.
// =====================================================================

import { vi } from 'vitest'
import type { FlagDatafile, Logger, LogLevel } from '@avsbhq/core'
import type { UnifiedStorageAdapter } from '@avsbhq/utils'

/** A key that passes shape validation, so tests do not trip the key warning. */
export const VALID_SDK_KEY = 'sdk_production_ttqm0eaj4vth1krcb2xn'

/**
 * Datafile with one always-on targeted_delivery flag, one 100%-to-treatment
 * ab_test flag (so exposures fire deterministically), one disabled flag, and
 * one string flag for typed-getter mismatch tests.
 */
export const testDatafile: FlagDatafile = {
  version: 2,
  projectType: 'FEATURE_FLAG',
  sdkKey: VALID_SDK_KEY,
  environmentKey: 'production',
  publishedAt: '2026-07-30T00:00:00.000Z',
  collectEndpoint: 'https://collect.test.invalid',
  heartbeatEndpoint: 'https://app.test.invalid/api/sdk/heartbeat',
  flags: [
    {
      id: 'flag_td',
      key: 'always-on',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var_off',
      variations: [
        { id: 'var_on', key: 'on', value: true },
        { id: 'var_off', key: 'off', value: false },
      ],
      overrides: [],
      rules: [
        {
          id: 'rule_td',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [{ variationId: 'var_on', percentage: 1 }],
        },
      ],
    },
    {
      id: 'flag_ab',
      key: 'checkout-v2',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var_control',
      variations: [
        { id: 'var_control', key: 'control', value: false },
        { id: 'var_treatment', key: 'treatment', value: true },
      ],
      overrides: [],
      rules: [
        {
          id: 'rule_ab_split',
          type: 'ab_test',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [{ variationId: 'var_treatment', percentage: 1 }],
        },
      ],
    },
    {
      id: 'flag_off',
      key: 'retired',
      type: 'boolean',
      enabled: false,
      defaultVariationId: 'var_retired_off',
      variations: [{ id: 'var_retired_off', key: 'off', value: false }],
      overrides: [],
      rules: [],
    },
    {
      id: 'flag_theme',
      key: 'theme',
      type: 'string',
      enabled: true,
      defaultVariationId: 'var_dark',
      variations: [{ id: 'var_dark', key: 'dark', value: 'midnight' }],
      overrides: [],
      rules: [
        {
          id: 'rule_theme',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [{ variationId: 'var_dark', percentage: 1 }],
        },
      ],
    },
  ],
  audiences: [],
}

export interface CapturedLine {
  level: LogLevel
  message: string
}

export interface CapturingLogger extends Logger {
  lines: CapturedLine[]
  messages(level?: LogLevel): string[]
  /** True when some captured line contains `needle`. */
  said(needle: string): boolean
}

/** Logger that records instead of printing, so assertions read on content. */
export function captureLogger(): CapturingLogger {
  const lines: CapturedLine[] = []
  const push = (level: LogLevel) => (message: string) => {
    lines.push({ level, message })
  }
  const logger: CapturingLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
    lines,
    messages: (level?: LogLevel) =>
      lines.filter((l) => (level ? l.level === level : true)).map((l) => l.message),
    said: (needle: string) => lines.some((l) => l.message.includes(needle)),
  }
  return logger
}

/** Minimal `Response`-shaped double: enough for the code paths under test. */
export function jsonResponse(
  body: unknown,
  init: { status?: number; etag?: string } = {},
): Response {
  const status = init.status ?? 200
  const headers = new Headers()
  if (init.etag) headers.set('etag', init.etag)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

/** A request with the given headers, for adapter contextFrom tests. */
export function requestWith(
  headers: Record<string, string>,
  url = 'https://shop.example.com/checkout?step=2',
): Request {
  return new Request(url, { headers })
}

/** The snippet's cookie value shape: percent-encoded JSON `{v, a}`. */
export function snippetCookie(visitorId: string): string {
  return encodeURIComponent(JSON.stringify({ v: visitorId, a: {} }))
}

/** Spelled out rather than imported so a rename shows up as a test change. */
export const VISITOR_HEADER = 'x-avsb-visitor-id'

/**
 * A Workers-shaped request: a standard `Request` with a `cf` property
 * attached, which is how Cloudflare hands geo to a Worker.
 *
 * Generic on the `cf` shape so the result is assignable to
 * `CloudflareRequest` without a cast.
 */
export function cfRequest<TCf = never>(
  headers: Record<string, string>,
  options: { cf?: TCf; url?: string } = {},
): Request & { cf?: TCf } {
  const req = new Request(options.url ?? 'https://shop.example.com/cart', { headers })
  return Object.assign(req, options.cf === undefined ? {} : { cf: options.cf })
}

/** Requests the stubbed global `fetch` received, as [url, init] pairs. */
export function fetchCalls(): Array<[string, RequestInit]> {
  const mock = fetch as unknown as { mock?: { calls: unknown[][] } }
  return (mock.mock?.calls ?? []) as Array<[string, RequestInit]>
}

/** The one request whose URL contains `needle`. Throws when there is none. */
export function fetchCallTo(needle: string): [string, RequestInit] {
  const found = fetchCalls().find(([url]) => url.includes(needle))
  if (!found) {
    throw new Error(
      `no fetch call to a URL containing "${needle}". Calls: ${fetchCalls()
        .map(([url]) => url)
        .join(', ')}`,
    )
  }
  return found
}

/** Parsed JSON body of a captured request. */
export function jsonBodyOf<T>(call: [string, RequestInit]): T {
  return JSON.parse(String(call[1].body)) as T
}

/** Storage double. Override one method to shape a cache-hit or failure case. */
export function makeStorage(
  overrides: Partial<UnifiedStorageAdapter> = {},
): UnifiedStorageAdapter {
  return {
    stickyLookup: vi.fn().mockReturnValue(null),
    stickySave: vi.fn(),
    datafileGet: vi.fn().mockResolvedValue(null),
    datafileSet: vi.fn().mockResolvedValue(undefined),
    isHealthy: vi.fn().mockReturnValue(true),
    ...overrides,
  }
}

/** A cache entry `cachedAt` this many ms ago. */
export function cachedAgo(ms: number): { datafile: FlagDatafile; cachedAt: number } {
  return { datafile: testDatafile, cachedAt: Date.now() - ms }
}
