// Re-export canonical types from @avsbhq/core.
// Packages consuming @avsbhq/node can import any of these from here; the
// source of truth lives in core.
export type {
  FlagDatafile,
  FlagDatafileEntry,
  FlagEvaluationDetails,
  ExposureEvent,
  MetricEvent,
  EvalContext,
  SingleContext,
  MultiContext,
  Flag,
  InitResult,
  StickyAssignment,
  StickyBucketService,
  DecisionLog,
  DecisionLogEntry,
  TrackPayload,
  RuleType,
  EvaluationSource,
  Logger,
  BanditDecisionLogEntry,
} from '@avsbhq/core'
export { DecideOption } from '@avsbhq/core'

// --- Server SDK options ---

import type {
  FlagDatafile,
  StickyBucketService,
  Logger,
} from '@avsbhq/core'
import type { ServerLogLevel } from './logger'

export interface AvsbServerOptions {
  /**
   * SDK key for the environment, shaped `sdk_<environment>_<id>`, for example
   * `sdk_production_ttqm0eaj4vth1krcb2xn`. Copy it from app.avsb.cloud, then
   * Environments in the project sidebar. The shape is checked at construction and an
   * unrecognisable value is logged (never thrown) with what looked wrong.
   */
  sdkKey: string
  /** Datafile polling interval in ms. Default: 60_000 (60s). Min: 5_000. */
  pollingInterval?: number
  /** CDN host for datafile fetches. Default: "https://cdn.avsb.cloud" */
  cdnHost?: string
  /** Max ms to wait for the initial datafile fetch in onReady(). Default: 10_000. */
  initTimeout?: number
  /** Pre-fetched datafile, so onReady() resolves without a network request. */
  bootstrap?: FlagDatafile
  /**
   * Real-time datafile updates over SSE. Default: TRUE on the server
   * (breaking change B12): server connection counts are low, one SSE stream
   * per process is cheaper than polling, and flag changes then land instantly.
   *
   * Falling back is invisible: if the datafile carries no `streamEndpoint` and
   * no `streamingEndpoint` option was passed, or the stream cannot be opened,
   * the SDK keeps polling and says so at debug level. Flags still update, just
   * on the polling interval. Pass `false` to force polling only.
   */
  streaming?: boolean
  /**
   * Stream TICKET endpoint. Overrides the datafile's `streamEndpoint` field.
   * Only needed for a self-hosted or proxied deployment whose publisher does
   * not set the field; nothing is ever guessed from another host.
   */
  streamingEndpoint?: string
  /** Event tracking configuration. */
  events?: EventOptions
  /** Pluggable sticky bucketing service. */
  stickyBucketService?: StickyBucketService
  /**
   * Custom logger. Default: console at warn level when NODE_ENV is neither
   * 'production' nor 'test', noop otherwise.
   */
  logger?: Logger
  /**
   * Shorthand for the default logger's level. `'silent'` restores the old
   * no-output behaviour. Ignored when `logger` is passed.
   */
  logLevel?: ServerLogLevel
}

export interface EventOptions {
  /** Ms between automatic event flushes. Default: 2000. */
  flushInterval?: number
  /** Max events per HTTP request. Default: 10. */
  batchSize?: number
  /**
   * Max events held in a queue. Oldest dropped when exceeded, with a warning.
   * Applies to the tracker's queues AND to the pre-ready queue that holds
   * events tracked before the first datafile arrives. Default: 10_000.
   */
  maxQueueSize?: number
  /** Retry attempts on flush failure. Default: 3. */
  retryAttempts?: number
}

// --- Public per-call option bags ---

import type { DecideOption, DecisionLog } from '@avsbhq/core'

/**
 * Options for a single evaluation. The CONTEXT is not in here: it is the third
 * positional argument of every evaluation call (breaking change B3), matching
 * `@avsbhq/edge`, so one shape reads the same in every server SDK.
 */
export interface ServerGetFlagOptions {
  /** Per-call decide options. See ./decideOptions.ts for the two members. */
  decideOptions?: DecideOption[]
  /** Append this evaluation to a decision log. */
  decisionLog?: DecisionLog
}

export interface GetAllFlagsOptions {
  /**
   * Record an exposure for every flag evaluated. Default FALSE: reading the
   * whole flag set is a diagnostic or an SSR bootstrap, not a decision a
   * visitor saw, and firing hundreds of exposures per request would corrupt
   * every experiment in the project.
   */
  fireExposures?: boolean
  decideOptions?: DecideOption[]
  /** Append every evaluation to a decision log. */
  decisionLog?: DecisionLog
}

// --- Legacy UserContext shape — kept for internal engine adaptation.
//
// The public API accepts EvalContext. Internally AvsbServer converts
// EvalContext → LegacyUserContext before calling the shared evaluator.
// Consumers should not depend on this type; it is removed when the evaluator
// consumes EvalContext natively.

export interface LegacyUserContext {
  userId: string
  attributes?: Record<string, unknown>
  suppressExposure?: boolean
  privateAttributes?: string[]
}

// --- Internal EvalResult (private to AvsbServer) ---

import type { EvaluationSource, RuleType } from '@avsbhq/core'

export interface EvalResult {
  value: unknown
  variationKey: string | null
  source: EvaluationSource
  ruleId: string | null
  ruleType: RuleType | null
  reasons: string[]
}

// --- Lifecycle events ---
//
// The payloads are the shared `ClientEventMap` shapes from @avsbhq/core, so a
// listener written against the browser client reads the same fields here. They
// used to diverge (`evaluation` carried `{flagKey, value, userId, source}` on
// the server and `{flagKey, flag, contextKeys}` in core), which the
// `client.utils` adapter papered over with a double cast: subscribing through
// `client.utils` handed you an object with none of the documented fields.

import type { StickyAssignment, Flag, ExposureEvent } from '@avsbhq/core'

export type ServerEventMap = {
  ready: () => void
  /** A newly published datafile was applied, and how it arrived. */
  configUpdate: (data: {
    publishedAt: string
    reason: 'poll' | 'stream' | 'manual'
  }) => void
  /** One flag was evaluated. Fires whether or not an exposure was recorded. */
  evaluation: (data: {
    flagKey: string
    flag: Flag
    contextKeys: string[]
  }) => void
  /**
   * An exposure was recorded and queued for delivery. This is the server-side
   * seam for forwarding decisions to your own analytics: it carries the SAME
   * `eventId` the ingestion pipeline receives, so rows reconcile across
   * systems.
   */
  exposure: (event: ExposureEvent) => void
  error: (error: Error) => void
  /** A sticky assignment references a rule that no longer matches the datafile. */
  stickyOrphan: (data: {
    flagKey: string
    userId: string
    assignment: StickyAssignment
  }) => void
}

export type ServerEventName = keyof ServerEventMap
