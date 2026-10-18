// =====================================================================
// AvsbEdgeClient — per-request client for Cloudflare Workers, Vercel Edge,
// Fastly Compute, Netlify Edge, Deno Deploy, Bun, and Lambda@Edge.
//
// No setInterval, no EventSource, no global state: one client per request,
// discarded with the response.
//
// The four things this rewrite fixed, each documented where it lives:
//   URL and exposures   ./core
//   readiness (B1/B15)  ./loadDatafile
//   event wire (B7)     ./events
//   loudness            ./logger, ./messages, ./sdkKeyShape
// =====================================================================

import type {
  EvalContext,
  ExposureEvent,
  ExpectedFlagType,
  Flag,
  FlagDatafile,
  InitResult,
  Logger,
  TrackPayload,
} from '@avsbhq/core'
import { visitorIdOf } from './requestContext'
import { checkTypedFlag } from './typedRead'
import type {
  EdgeClientOptions,
  EdgeErrorSource,
  GetAllFlagsOptions,
  GetFlagOptions,
} from './types'
import { DEFAULT_DATAFILE_TIMEOUT_MS } from './core'
import { createEdgeEventQueue, type EdgeEventQueue } from './events'
import { loadDatafile, type DatafileOrigin } from './loadDatafile'
import { logOnce, resolveLogger } from './logger'
import { reportConstructionIssues } from './sdkKeyShape'
import { emptyContextMessage, trackPropertiesDroppedMessage } from './messages'
import { acceptOptionDatafile, livenessReport } from './edgeDatafile'
import {
  readAllEdgeFlags,
  readEdgeFlag,
  resolveEdgeContext,
  type EdgeReadScope,
} from './edgeEvaluation'

const DEFAULT_CACHE_TTL_MS = 300_000

/** Where the in-memory datafile came from. 'none' means nothing is loaded. */
type DatafileSource = DatafileOrigin | 'none'

export class AvsbEdgeClient {
  private readonly sdkKey: string
  private readonly cdnHost: string | undefined
  private readonly storage: EdgeClientOptions['storage']
  private readonly waitUntilFn: EdgeClientOptions['waitUntil']
  private readonly fetchDatafileFn: EdgeClientOptions['fetchDatafile']
  private readonly boundContext: EvalContext | undefined
  private readonly cacheTtlMs: number
  private readonly timeoutMs: number
  private readonly heartbeatEnabled: boolean
  private readonly pageUrl: string | undefined
  private readonly logger: Logger
  private readonly onError: EdgeClientOptions['onError']
  private readonly maxQueueSize: number | undefined
  private readonly eventRetryAttempts: number | undefined

  private datafile: FlagDatafile | null
  private datafileSource: DatafileSource
  private initResult: InitResult | null = null
  private initPromise: Promise<InitResult> | null = null
  private queue: EdgeEventQueue | null = null
  /** Deferred work on runtimes without waitUntil, awaited by flushEvents(). */
  private deferred: Array<Promise<unknown>> = []

  constructor(options: EdgeClientOptions) {
    this.sdkKey = options.sdkKey
    this.cdnHost = options.cdnHost
    this.storage = options.storage
    this.waitUntilFn = options.waitUntil
    this.fetchDatafileFn = options.fetchDatafile
    this.boundContext = options.context
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DATAFILE_TIMEOUT_MS
    this.heartbeatEnabled = options.heartbeat !== false
    this.pageUrl = options.pageUrl
    this.logger = resolveLogger(options)
    this.onError = options.onError
    this.maxQueueSize = options.maxQueueSize
    this.eventRetryAttempts = options.eventRetryAttempts

    // A malformed `datafile` option is refused with a logged reason (N0-15):
    // the client starts without one and init() loads from the CDN.
    this.datafile = options.datafile
      ? acceptOptionDatafile(options.datafile, this.sdkKey, this.cdnHost, this.logger)
      : null
    this.datafileSource = this.datafile ? 'bootstrap' : 'none'

    reportConstructionIssues({
      sdkKey: this.sdkKey,
      datafile: options.datafile,
      logger: this.logger,
    })
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------

  /**
   * Load the datafile. Idempotent: concurrent callers share one attempt and
   * a second call returns the first result rather than re-fetching. Never
   * rejects: failures come back on the `InitResult`, the logger, and `onError`.
   */
  init(): Promise<InitResult> {
    if (this.initResult) return Promise.resolve(this.initResult)
    if (this.initPromise) return this.initPromise
    this.initPromise = this.runInit()
    return this.initPromise
  }

  /** The result of `init()`, or null before it has settled. */
  getInitResult(): InitResult | null {
    return this.initResult
  }

  /** True when a datafile is loaded and flags evaluate for real. */
  isReady(): boolean {
    return this.datafile !== null
  }

  /** The datafile in memory, for debugging and SSR handoff. */
  getDatafile(): FlagDatafile | null {
    return this.datafile
  }

  /** The context this client evaluates against when none is passed. */
  getContext(): EvalContext | undefined {
    return this.boundContext
  }

  private async runInit(): Promise<InitResult> {
    if (this.datafileSource === 'bootstrap') {
      return this.settle({ success: true, source: 'bootstrap' })
    }

    const outcome = await loadDatafile({
      sdkKey: this.sdkKey,
      cdnHost: this.cdnHost,
      timeoutMs: this.timeoutMs,
      cacheTtlMs: this.cacheTtlMs,
      storage: this.storage,
      fetchDatafile: this.fetchDatafileFn,
      logger: this.logger,
      report: (error, source) => this.report(error, source),
      defer: (work) => this.defer(work),
    })

    this.datafile = outcome.datafile
    this.datafileSource = outcome.origin ?? 'none'

    // Only a real network fetch reports liveness. A cache hit did not talk to
    // the platform, so claiming it did would keep an environment looking
    // Connected long after its last successful fetch.
    if (outcome.origin === 'network') this.reportLiveness()

    return this.settle(outcome.result)
  }

  private settle(result: InitResult): InitResult {
    this.initResult = result
    return result
  }

  /**
   * Hand background work to `waitUntil`, or hold it for `flushEvents()` to
   * await on the four runtimes that have none (without which a cache write
   * on Lambda@Edge is cancelled the moment the response returns).
   */
  private defer(work: Promise<unknown>): void {
    if (this.waitUntilFn) {
      this.waitUntilFn(work)
      return
    }
    this.deferred.push(work)
  }

  /** Log once for the isolate, then notify. Used where nothing else logs. */
  private report(error: Error, source: EdgeErrorSource): void {
    logOnce(this.logger, 'error', `${source}:${error.message}`, error.message)
    this.notify(error, source)
  }

  /**
   * Notify only. The queue and the heartbeat log their own line at the level
   * that suits them, so this is the seam that keeps every `EdgeErrorSource`
   * member firing without re-logging at error level.
   */
  private notify(error: Error, source: EdgeErrorSource): void {
    this.onError?.(error, source)
  }

  private reportLiveness(): void {
    const work = livenessReport({
      heartbeatEnabled: this.heartbeatEnabled,
      datafile: this.datafile,
      sdkKey: this.sdkKey,
      logger: this.logger,
      notify: (error, source) => this.notify(error, source),
    })
    if (work) this.defer(work)
  }

  // -------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------

  /**
   * Evaluate one flag. `context` is optional: without it the client uses the
   * context bound at construction, which adapters build from the request.
   */
  getFlag<T>(
    flagKey: string,
    defaultValue: T,
    context?: EvalContext,
    options?: GetFlagOptions,
  ): Flag<T> {
    return readEdgeFlag(flagKey, defaultValue, this.readScope(context, options?.fireExposure !== false))
  }

  getBoolFlag(
    flagKey: string,
    defaultValue: boolean,
    context?: EvalContext,
    options?: GetFlagOptions,
  ): Flag<boolean> {
    return this.readTyped(flagKey, defaultValue, 'boolean', context, options)
  }

  getStringFlag(
    flagKey: string,
    defaultValue: string,
    context?: EvalContext,
    options?: GetFlagOptions,
  ): Flag<string> {
    return this.readTyped(flagKey, defaultValue, 'string', context, options)
  }

  getNumberFlag(
    flagKey: string,
    defaultValue: number,
    context?: EvalContext,
    options?: GetFlagOptions,
  ): Flag<number> {
    return this.readTyped(flagKey, defaultValue, 'number', context, options)
  }

  /** `T` is the shape you expect; it is not validated field by field. */
  getJsonFlag<T>(
    flagKey: string,
    defaultValue: T,
    context?: EvalContext,
    options?: GetFlagOptions,
  ): Flag<T> {
    return this.readTyped(flagKey, defaultValue, 'json', context, options)
  }

  /**
   * The four typed getters above share this body: evaluate, then check the
   * type the datafile declares. A mismatch returns the default rather than
   * coercing. See ./typedRead.
   */
  private readTyped<T>(
    flagKey: string,
    defaultValue: T,
    expected: ExpectedFlagType,
    context?: EvalContext,
    options?: GetFlagOptions,
  ): Flag<T> {
    return checkTypedFlag(this.getFlag(flagKey, defaultValue, context, options), {
      flagKey,
      defaultValue,
      expected,
      datafile: this.datafile,
      logger: this.logger,
    })
  }

  /**
   * Evaluate every flag in the datafile. Fires NO exposures by default: see
   * `GetAllFlagsOptions.fireExposures`.
   */
  getAllFlags(context?: EvalContext, options?: GetAllFlagsOptions): Record<string, Flag> {
    return readAllEdgeFlags(this.readScope(context, options?.fireExposures === true))
  }

  /** The state one read sees. See ./edgeEvaluation. */
  private readScope(context: EvalContext | undefined, fireExposure: boolean): EdgeReadScope {
    return {
      datafile: this.datafile,
      logger: this.logger,
      resolveContext: () => resolveEdgeContext(context, this.boundContext, this.logger),
      onExposure: fireExposure ? (event) => this.recordExposure(event) : undefined,
    }
  }

  // -------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------

  private events(): EdgeEventQueue {
    if (!this.queue) {
      this.queue = createEdgeEventQueue({
        sdkKey: this.sdkKey,
        // A resolver, not a snapshot. See EdgeEventQueueOptions.
        collectEndpoint: () => this.datafile?.collectEndpoint,
        logger: this.logger,
        onError: (error, source) => this.notify(error, source),
        maxQueueSize: this.maxQueueSize,
        timeoutMs: this.timeoutMs,
        retryAttempts: this.eventRetryAttempts,
      })
    }
    return this.queue
  }

  /**
   * The evaluator's exposure sink. Fills `pageUrl` when the evaluator could
   * not (there is no `location` on a server), so an edge exposure is still
   * attributable to the page that was being served.
   */
  private recordExposure(event: ExposureEvent): void {
    const requestUrl = this.pageUrl
    if (!event.pageUrl && requestUrl) {
      this.events().queueExposure({ ...event, pageUrl: requestUrl })
      return
    }
    this.events().queueExposure(event)
  }

  /**
   * Queue a conversion or metric event.
   *
   * TWO numeric columns, not one (breaking change B36). `payload.revenue` is
   * money in decimal MAJOR units and lands in `revenue`; `payload.value` is
   * the numeric metric value for average-value metrics (items, seats,
   * seconds) and lands in the separate `value` column. Storage and the locked
   * wire fixture declare both, and every other A vs B SDK maps them this way.
   * This client used to ship `payload.value` into the revenue column and could
   * never write `value` at all, so a quantity was recorded as money and an
   * edge-tracked average-value metric read empty.
   *
   * `payload.properties` is NOT stored on tracked events, so it is dropped
   * with one warning rather than shipped and silently discarded (see
   * `trackPropertiesDroppedMessage`).
   */
  track(eventKey: string, payload?: TrackPayload): void {
    if (payload?.properties) {
      const key = `track-properties:${eventKey}`
      logOnce(this.logger, 'warn', key, trackPropertiesDroppedMessage(eventKey))
    }

    const visitorId = visitorIdOf(payload?.context ?? this.boundContext)
    if (!visitorId) {
      // An event with no visitor cannot be attributed to anyone, so it can
      // never join an exposure in results. Same key as the evaluation-side
      // warning, so a request that reads a flag and tracks says it once.
      logOnce(this.logger, 'warn', 'empty-context', emptyContextMessage())
    }

    this.events().queueMetric({
      visitorId,
      eventName: eventKey,
      revenue: payload?.revenue ?? null,
      value: payload?.value ?? null,
      timestamp: Date.now(),
      pageUrl: this.pageUrl ?? '',
    })
  }

  /**
   * Send everything this request produced: queued exposures, queued tracked
   * events, and any deferred cache write or heartbeat.
   *
   * Safe to call with nothing queued. Pass it to `ctx.waitUntil` where the
   * runtime has one, and `await` it before returning where it does not.
   */
  async flushEvents(): Promise<void> {
    const pending = this.deferred
    this.deferred = []
    await Promise.all([this.queue ? this.queue.flush() : Promise.resolve(), ...pending])
  }

  /** Queue depths. Diagnostics and tests. */
  queueSize(): { events: number; metricEvents: number } {
    return this.queue ? this.queue.size() : { events: 0, metricEvents: 0 }
  }
}
