// =====================================================================
// @avsbhq/edge public option and result types.
//
// Every field carries the type a caller sees in an IntelliSense hover, and
// the README quotes these blocks verbatim, so a change here is a change to
// the documentation (spec §1.7, docs-visible type safety).
// =====================================================================

import type { EvalContext, FlagDatafile, Logger } from '@avsbhq/core'
import type { UnifiedStorageAdapter } from '@avsbhq/utils'
import type { EdgeLogLevel } from './logger'

// Re-export the shared core types so a consumer imports everything the edge
// client speaks from one place.
export type {
  EvalContext,
  SingleContext,
  MultiContext,
  Flag,
  FlagDatafile,
  FlagDatafileEntry,
  FlagDatafileVariation,
  FlagDatafileRule,
  FlagDatafileAudience,
  InitResult,
  EvaluationSource,
  RuleType,
  ExposureEvent,
  MetricEvent,
  TrackPayload,
  Logger,
  LogLevel,
} from '@avsbhq/core'
export type { UnifiedStorageAdapter } from '@avsbhq/utils'
export type { EdgeLogLevel } from './logger'

// ---------------------------------------------------------------------
// EdgeClientOptions
// ---------------------------------------------------------------------

export interface EdgeClientOptions {
  /**
   * Environment SDK key, shaped `sdk_<environment>_<id>`. Validated at
   * construction: a key that does not match logs an actionable error naming
   * where keys live, then the client proceeds so the datafile request is the
   * real arbiter.
   */
  sdkKey: string

  /**
   * Context every `getFlag` call evaluates against when none is passed
   * positionally. Adapters set this from their `contextFrom`, which is what
   * makes `client.getFlag('key', false)` work with no third argument.
   */
  context?: EvalContext

  /** Pre-fetched datafile. When present, `init()` performs no network call. */
  datafile?: FlagDatafile

  /**
   * Replace the built-in datafile fetch. Return null to mean "could not get
   * it"; the client then treats the init as failed (or degraded, when a
   * cached copy exists) and logs why.
   */
  fetchDatafile?: (sdkKey: string) => Promise<FlagDatafile | null>

  /** CDN origin for datafile reads. Default `https://cdn.avsb.cloud`. */
  cdnHost?: string

  /**
   * Runtime-native cache (CF KV, Deno KV, Fastly KV Store, process memory).
   * `init()` reads it before the network and writes back after a successful
   * fetch. Adapters build one from the binding you hand them.
   */
  storage?: UnifiedStorageAdapter

  /**
   * How long a cached datafile counts as FRESH, in ms. Default 300000
   * (5 minutes). Past it the client revalidates over the network and, if
   * that fails, serves the stale copy with `degraded: true`.
   *
   * Freshness lives here rather than in each storage adapter so all seven
   * runtimes behave identically. Adapters keep their own RETENTION bound
   * (how long an entry is stored at all), which is a garbage-collection
   * concern, not a correctness one.
   */
  cacheTtlMs?: number

  /** Ms budget for one datafile request. Default 3000. */
  timeoutMs?: number

  /**
   * Report SDK liveness after a successful network fetch, which is what
   * drives Connected / Stale / Not connected on the Environments page.
   * Default true. Sent at most once per client, through `waitUntil` when the
   * runtime has one, so it never delays a response.
   */
  heartbeat?: boolean

  /**
   * Runtime `waitUntil`. Adapters wire this so cache writes, heartbeats, and
   * event flushes run after the response has been returned.
   */
  waitUntil?: (p: Promise<unknown>) => void

  /**
   * URL of the request being served. Written to `pageUrl` on exposure events
   * that would otherwise carry an empty string, so edge exposures are
   * attributable to a page. Adapters set it from the request.
   */
  pageUrl?: string

  /** Explicit logger. Wins over `logLevel`. */
  logger?: Logger

  /**
   * Threshold for the built-in console logger, or `'silent'` for no output.
   * Default: `debug` in development, `warn` otherwise. Unlike the browser
   * SDK the edge default is never silent, because edge logs go to the
   * operator's own log stream rather than an end user's console.
   */
  logLevel?: EdgeLogLevel

  /**
   * Called for every error the client would otherwise only log. `source`
   * says which stage failed, so a handler can page on `'init'` and ignore
   * `'events'`.
   */
  onError?: (error: Error, source: EdgeErrorSource) => void

  /** Max events held in one request before the oldest are dropped. Default 500. */
  maxQueueSize?: number

  /** Retries per failed event batch, inside the same request. Default 1. */
  eventRetryAttempts?: number
}

/** Stage that produced an error handed to `onError`. */
export type EdgeErrorSource = 'init' | 'cache' | 'events' | 'heartbeat'

// ---------------------------------------------------------------------
// Per-call options
// ---------------------------------------------------------------------

export interface GetFlagOptions {
  /**
   * Fire an exposure event for this evaluation. Default true. Set false for
   * a read that must not count as serving the flag to this visitor (a debug
   * panel, a log line, a health check).
   */
  fireExposure?: boolean
}

export interface GetAllFlagsOptions {
  /**
   * Fire an exposure per evaluated flag. Default FALSE. A bulk read is not a
   * decision served to a visitor, and firing one exposure per flag would
   * attribute every visitor to every experiment at once. Matches the browser
   * client's default.
   */
  fireExposures?: boolean
}

// ---------------------------------------------------------------------
// Thin aliases for Web-standard Request/Response.
// ---------------------------------------------------------------------

export type EdgeRequest = Request
export type EdgeResponse = Response

// ---------------------------------------------------------------------
// Adapter option shapes shared by all seven runtimes.
// ---------------------------------------------------------------------

/**
 * Client options an adapter owns and a caller therefore cannot pass:
 * `sdkKey`, `storage`, `waitUntil`, `context`, and `pageUrl` are all derived
 * from the request and the adapter's own bindings.
 */
export type AdapterClientOptions = Omit<
  EdgeClientOptions,
  'sdkKey' | 'storage' | 'waitUntil' | 'context' | 'pageUrl'
>

