import type { ExposureEvent, MetricEvent, FlagDatafile, EvalContext } from '@avsbhq/core'
import type { BrowserLogLevel } from './logger'

// Re-export the shared core types so consumers can import everything the
// browser client speaks from one place.
export type {
  FlagEvaluationDetails,
  FlagDatafile,
  FlagDatafileEntry,
  FlagDatafileVariation,
  FlagDatafileOverride,
  FlagDatafileRule,
  FlagDatafileAudience,
  ConditionGroup,
  Condition,
  EvalContext,
  SingleContext,
  MultiContext,
  ExposureEvent,
  MetricEvent,
  Flag,
  InitResult,
  TrackPayload,
  DecideOption,
  EvaluationSource,
  Logger,
  ClientEventMap,
  ClientEventName,
  AvsbFlagKey,
  AvsbFlagValue,
} from '@avsbhq/core'
export { isConditionGroup } from '@avsbhq/core'

// --- Browser client options ---

export interface AvsbClientOptions {
  sdkKey: string
  /**
   * The identity flags are evaluated against. THE identity model: the parallel
   * `attributes` + `userIdAttribute` pair was deleted (breaking change B5),
   * because two models meant every adapter and doc had to teach both and the
   * second could not express multi-context at all. Migration is mechanical:
   * `attributes: { userId, plan }` becomes
   * `context: { kind: 'user', key: userId, plan }`.
   *
   * Omit it and the SDK evaluates against a PERSISTED anonymous context (see
   * `adoptSnippetVisitorId`), not a fresh key per page load.
   */
  context?: EvalContext
  /**
   * Datafile polling interval in ms. Default 60_000. Clamped to a 5_000
   * minimum (matching @avsbhq/node) and scheduled with plus or minus 10%
   * jitter.
   */
  pollingInterval?: number
  autoRefresh?: boolean
  bootstrap?: FlagDatafile
  /** CDN host for datafile fetches. Default: 'https://cdn.avsb.cloud' */
  cdnHost?: string
  /**
   * Start loading the datafile from the constructor. Default true.
   *
   * `onReady()` still returns the awaitable result; it no longer has to be
   * called to kick initialisation off. Pass false for tests or for a
   * server render where the client is built but must never reach the
   * network until you say so.
   */
  autoInit?: boolean
  /**
   * Max ms one datafile request may take before it is aborted. Default
   * 10_000, matching @avsbhq/node's `initTimeout`. This bounds the REQUEST;
   * `onReady({ timeout })` bounds how long you wait for the result.
   */
  initTimeout?: number
  /**
   * Cache the datafile in localStorage and serve it on the next load while
   * a refresh runs behind it (cache-then-network). Default true.
   */
  cache?: boolean
  /**
   * How old a cached datafile may be and still be served on startup.
   * Default 7 days.
   */
  cacheMaxAgeMs?: number
  /**
   * Adopt the Web Experiments snippet's `_avsb_visitor` id when the
   * snippet is installed on the same page, so flag exposures and web
   * experiment exposures join to one visitor. Read only: the SDK never
   * writes that cookie. Default true.
   */
  adoptSnippetVisitorId?: boolean
  /** Stop polling while the tab is hidden. Default true. */
  pauseWhenHidden?: boolean
  /** Refetch the datafile when the window regains focus. Default true. */
  refetchOnFocus?: boolean
  /**
   * Max `track` calls held while the tracker is still coming up. Default
   * 100. Oldest are dropped past the cap, with one warning, so a page that
   * never reaches ready cannot grow memory without limit.
   */
  maxPendingEvents?: number
  /** Event tracker tuning. Mirrors @avsbhq/node's `events` option. */
  events?: BrowserEventOptions
  /**
   * §5.5 pluggable logger. Defaults to a console logger at warn level in
   * development and a noop elsewhere (spec §1.2). See `logLevel` for the
   * one-word form.
   */
  logger?: import('@avsbhq/core').Logger
  /**
   * Shorthand for the default logger's level: 'silent' turns SDK logging
   * off, any log level turns it on at that level. Ignored when `logger`
   * is passed.
   */
  logLevel?: BrowserLogLevel
  /** §5.5 called for unrecoverable errors alongside the 'error' event bus emission. */
  onError?: (
    e: Error,
    source: 'init' | 'poll' | 'stream' | 'track' | 'eval'
  ) => void
  /**
   * §8.4: when true, subscribe to server-sent datafile updates instead of
   * (or in addition to) polling.
   */
  streaming?: boolean
  /**
   * §8.4 SSE ticket endpoint. Optional: the datafile carries
   * `streamEndpoint`, which is the normal source. When neither exists the
   * SDK says so and stays on polling. It never guesses a host.
   */
  streamingEndpoint?: string
  /**
   * The framework package this client runs inside, reported on the liveness
   * heartbeat INSTEAD of `@avsbhq/browser`, so the Environments page names the
   * package the customer installed (N1-14). @avsbhq/react, vue, svelte, solid,
   * angular, next, nuxt and react-native set it; an application never needs
   * to. Without it the client reports itself.
   */
  wrapper?: SdkWrapperIdentity
}

/** What a liveness heartbeat reports about the SDK that sent it. */
export interface SdkWrapperIdentity {
  /** Published package name, for example `@avsbhq/react`. */
  sdkType: string
  /** That package's version, from its package.json. */
  sdkVersion: string
}

/** Event tracker tuning. Field-for-field mirror of @avsbhq/node's EventOptions. */
export interface BrowserEventOptions {
  /** Ms between automatic flushes. Default 2000. */
  flushInterval?: number
  /** Max events per HTTP request. Default 10. */
  batchSize?: number
  /** Max events held per queue. Oldest dropped past it. Default 500. */
  maxQueueSize?: number
  /** Retry attempts per failed send. Default 3. */
  retryAttempts?: number
}

// §5.11 options passed to individual getFlag* calls
export interface GetFlagOptions {
  /** Fire an exposure event for this evaluation. Default: true. */
  fireExposure?: boolean
  /**
   * Render-safe read (report 03 handoff item 3). Implies
   * `fireExposure: false`, emits no `evaluation` event, and returns the
   * cached, referentially stable Flag that `getSnapshot` returns. This is
   * the mode framework adapters use inside render and inside
   * `useSyncExternalStore`'s `getSnapshot`.
   */
  readOnly?: boolean
  /**
   * Per-call decide options. `DISABLE_EXPOSURE` is honoured (same as
   * `fireExposure: false`); `INCLUDE_REASONS` is a no-op because the
   * browser now always collects reasons.
   */
  decideOptions?: import('@avsbhq/core').DecideOption[]
}

// §5.7 options for getAllFlags
//
// No `decideOptions` here on purpose. A bulk read is exposure-OFF by
// default, so `DISABLE_EXPOSURE` would only duplicate `fireExposures` with
// a precedence rule to memorise, and `INCLUDE_REASONS` is satisfied
// unconditionally (the browser always collects reasons). Declaring an
// option that changes nothing is the accepted-and-never-read pattern report
// 02 §5.7 exists to kill, so the field is gone rather than honoured.
// `DecideOption` still applies to single-flag reads, where exposure is on by
// default and `DISABLE_EXPOSURE` therefore means something.
export interface GetAllFlagsOptions {
  /** Default false: bulk reads do not fire exposure events. */
  fireExposures?: boolean
  /**
   * Evaluate against this context instead of the bound one, without
   * changing the bound context (report 02 §5.29). This is what makes
   * `client.utils.snapshot(ctx)` produce a snapshot for the context it was
   * asked about instead of silently answering for the current visitor.
   */
  context?: EvalContext
}

// --- Browser tracker shape (uses shared event types) ---

export interface Tracker {
  queue: (event: ExposureEvent) => void
  queueMetric: (event: MetricEvent) => void
  flush: () => Promise<void>
  destroy: () => Promise<void>
  /** Current queue depths. Diagnostics and tests. */
  size?: () => { events: number; metricEvents: number }
}
