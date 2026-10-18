import type { FlagDatafile, EvalContext, ExposureEvent, Flag, InitResult } from '@avsbhq/core'
import type { DecisionLog, TrackPayload } from '@avsbhq/core'
import { createDatasetsClient } from './datasets'
import type { DatasetsClient } from './datasets'
import { createRecsClient } from './recs'
import type { RecsClient } from './recs'
import { createDecisionLog } from './decisionLog'
import { bucketingKey } from '@avsbhq/core'
import type { PurchaseOrder, ServerTracker } from './serverTracker'
import type {
  AvsbServerOptions,
  GetAllFlagsOptions,
  ServerEventMap,
  ServerEventName,
  ServerGetFlagOptions,
} from './types'
import { createUserBoundClient } from './UserBoundClient'
import type { UserBoundClient } from './UserBoundClient'
import { buildServerUtils } from './utils'
import type { AvsbUtils } from '@avsbhq/utils'
import { addListener, createServerState, onSharedEvent } from './serverState'
import type { InternalGetFlagOptions, ServerState } from './serverState'
import {
  applyDatafileBootstrap,
  closeServer,
  initializeAndReady,
  refreshDatafile,
} from './serverDatafile'
import { evaluateAllServerFlags, evaluateServerFlag } from './serverEvaluation'
import { manualExposure } from './serverDecision'
import { deliverExposure, initTracker, trackMetric, trackPurchase } from './serverTracking'

// The class is the public surface. Its state lives in one object
// (./serverState) and the work is done in ./serverDatafile,
// ./serverEvaluation, ./serverDecision, ./serverTracking and
// ./serverStreaming (FU-31).

// Declared beside the state since the split; UserBoundClient still imports it from here.
export type { InternalGetFlagOptions }

export class AvsbServer {
  /** Everything mutable about this client. See ./serverState. */
  private readonly s: ServerState

  // Private seams kept on the instance because
  // AvsbServer.exposureDelivery.test.ts reaches them directly to stage a
  // missing tracker. Each one is a straight pass-through to the state.
  private get tracker(): ServerTracker | null {
    return this.s.tracker
  }
  private set tracker(tracker: ServerTracker | null) {
    this.s.tracker = tracker
  }
  private deliverExposure(event: ExposureEvent): void {
    deliverExposure(this.s, event)
  }
  private initTracker(): void {
    initTracker(this.s, this)
  }

  /**
   * `client.utils.*` surface, constructed lazily on first access so the utils
   * package is only imported when actually consumed.
   */
  private _utils: AvsbUtils | null = null
  get utils(): AvsbUtils {
    if (!this._utils) {
      this._utils = buildServerUtils({
        getAllFlags: (ctx, opts) => this.getAllFlags(ctx, opts),
        getFlag: <T,>(flagKey: string, defaultValue: T, context?: EvalContext) =>
          this.getFlag<T>(flagKey, defaultValue, context),
        track: (eventKey, payload) => this.track(eventKey, payload),
        on: (event, cb) => onSharedEvent(this.s, this, event, cb),
        getDatafile: () => this.s.datafile,
        applyDatafileBootstrap: (df) => this.applyDatafileBootstrap(df),
        refreshDatafile: () => this.refreshDatafile(),
      })
    }
    return this._utils
  }

  /**
   * Server-side datasets read surface. `client.datasets.get(slug, key)`
   * resolves the live version from the current datafile and never throws.
   */
  private _datasets: DatasetsClient | null = null
  get datasets(): DatasetsClient {
    if (!this._datasets) {
      this._datasets = createDatasetsClient({
        sdkKey: this.s.sdkKey,
        getDatafile: () => this.s.datafile,
        logger: this.s.logger,
      })
    }
    return this._datasets
  }

  /**
   * Server-side recommendations surface. `client.recs.get({ recipe, … })`
   * resolves the recipe registry from the current datafile and never throws;
   * impressions and clicks ride the server tracker's queue and revenue
   * attaches via `trackPurchase`.
   */
  private _recs: RecsClient | null = null
  get recs(): RecsClient {
    if (!this._recs) {
      this._recs = createRecsClient({
        sdkKey: this.s.sdkKey,
        getDatafile: () => this.s.datafile,
        getTracker: () => this.s.tracker,
        logger: this.s.logger,
      })
    }
    return this._recs
  }

  constructor(options: AvsbServerOptions) {
    this.s = createServerState(options)

    // The tracker is built HERE for a bootstrapped client, not left to
    // `onReady()`. A bootstrap sets `ready = true` above, so `isReady()` says
    // yes and flags answer on this very tick, while every exposure they
    // produced went to a tracker that did not exist yet. Awaiting `onReady()`
    // is exactly what a bootstrap exists to avoid, so a customer following the
    // documented "instant start" lost every exposure AND never drained the
    // pre-ready event queue, because only `initTracker` drains it. This
    // mirrors the same fix in @avsbhq/browser's constructor. Idempotent, so
    // the later call from `onDatafileReadable` is a no-op.
    if (this.s.datafile) this.initTracker()
  }

  // ---- Readiness ----

  /**
   * Await the init attempt. Never rejects; always resolves to an InitResult.
   * Calling it twice returns the same promise.
   */
  onReady(): Promise<InitResult> {
    if (this.s.readyPromise) return this.s.readyPromise
    this.s.readyPromise = initializeAndReady(this.s, this)
    return this.s.readyPromise
  }

  /** True when a datafile is loaded and flags are answerable right now. */
  isReady(): boolean {
    return this.s.ready && this.s.datafile !== null
  }

  // ---- Lifecycle ----

  close(): Promise<void> {
    return closeServer(this.s, () => this._utils?._drain())
  }

  async flush(): Promise<void> {
    if (this.s.tracker) await this.s.tracker.flush()
  }

  /**
   * Fetch the datafile now and apply it if it changed.
   *
   * A 304 is not a problem and is not warned about: it means the datafile in
   * memory IS the published one.
   */
  refreshDatafile(): Promise<void> {
    return refreshDatafile(this.s, this)
  }

  /**
   * Adopt a datafile received out of band: a bootstrap blob from
   * `client.utils.hydrateBootstrap`, a file on disk, a KV read at cold start.
   *
   * Marks the SDK ready, drains anything queued before it, and starts polling
   * and streaming exactly as a network arrival would. This used to be a no-op
   * comment inside the utils adapter, which made the documented bootstrap
   * handoff silently do nothing.
   */
  applyDatafileBootstrap(datafile: FlagDatafile): void {
    applyDatafileBootstrap(this.s, this, datafile)
  }

  /** The datafile currently in memory, or null before init completes. */
  getDatafile(): FlagDatafile | null {
    return this.s.datafile
  }

  // ---- Evaluation ----
  // Context is the THIRD POSITIONAL argument on every call (B3), matching
  // @avsbhq/edge. `forUser(ctx)` is the primary server pattern and binds it
  // once per request.

  getFlag<T>(
    flagKey: string,
    defaultValue: NoInfer<T> | T,
    context?: EvalContext,
    options?: ServerGetFlagOptions
  ): Flag<T> {
    return this.evaluateInternal<T>(flagKey, defaultValue, context, options)
  }

  getBoolFlag(
    flagKey: string,
    defaultValue: NoInfer<boolean> | boolean,
    context?: EvalContext,
    options?: ServerGetFlagOptions
  ): Flag<boolean> {
    return this.evaluateInternal<boolean>(flagKey, defaultValue, context, {
      ...options,
      expectedType: 'boolean',
    })
  }

  getStringFlag(
    flagKey: string,
    defaultValue: NoInfer<string> | string,
    context?: EvalContext,
    options?: ServerGetFlagOptions
  ): Flag<string> {
    return this.evaluateInternal<string>(flagKey, defaultValue, context, {
      ...options,
      expectedType: 'string',
    })
  }

  getNumberFlag(
    flagKey: string,
    defaultValue: NoInfer<number> | number,
    context?: EvalContext,
    options?: ServerGetFlagOptions
  ): Flag<number> {
    return this.evaluateInternal<number>(flagKey, defaultValue, context, {
      ...options,
      expectedType: 'number',
    })
  }

  getJsonFlag<T>(
    flagKey: string,
    defaultValue: NoInfer<T> | T,
    context?: EvalContext,
    options?: ServerGetFlagOptions
  ): Flag<T> {
    return this.evaluateInternal<T>(flagKey, defaultValue, context, {
      ...options,
      expectedType: 'json',
    })
  }

  /**
   * @internal Single evaluation entry point for this package. `UserBoundClient`
   * calls it with a bound context and forced decisions. Not part of the
   * published API: its options bag carries package-internal fields.
   */
  evaluateInternal<T>(
    flagKey: string,
    defaultValue: NoInfer<T> | T,
    context?: EvalContext,
    options?: InternalGetFlagOptions
  ): Flag<T> {
    return evaluateServerFlag<T>(this.s, this, flagKey, defaultValue, context, options)
  }

  /**
   * Every flag in the environment, evaluated against one context.
   *
   * Positional context (B3). Note the deliberate difference from
   * `@avsbhq/browser`, which keeps an options bag (`getAllFlags({context})`)
   * because it is context-bound and the bag disambiguates its optional
   * arguments.
   */
  getAllFlags(
    context?: EvalContext,
    options?: GetAllFlagsOptions
  ): Record<string, Flag> {
    return evaluateAllServerFlags(this.s, this, context, options)
  }

  // ---- Tracking ----

  /**
   * Queue a metric (conversion) event. Synchronous: it returns as soon as the
   * event is queued, and the tracker batches it.
   *
   * The context rides in the payload rather than positionally because it is
   * OPTIONAL vocabulary on the shared `TrackPayload` type and required only on
   * the server; see the README for why the two runtimes read differently here.
   */
  track(eventKey: string, payload: TrackPayload & { context: EvalContext }): void {
    trackMetric(this.s, eventKey, payload)
  }

  /**
   * Send a purchase to `/v1/collect/orders`.
   *
   * Queued before the tracker exists, exactly like `track` (they used to
   * disagree: one queued, the other warned and dropped the order).
   */
  trackPurchase(visitorId: string, order: PurchaseOrder): Promise<void> {
    return trackPurchase(this.s, visitorId, order)
  }

  /**
   * Mark the moment a signup or login claimed an anonymous session. Same shape
   * and same honesty as the browser client's `alias`.
   *
   * WHAT IT DOES: queues one `avsb_alias` event attributed to the NEW
   * identity's key.
   *
   * WHAT IT DOES NOT DO, precisely:
   *   - It does not rewrite sticky assignments or move past exposures. Nothing
   *     already decided for either identity changes.
   *   - It does not store the PREVIOUS key. The conversion wire
   *     (`/v1/collect/metric-batch`) carries no properties column, so a
   *     retroactive session join is not available yet.
   *
   * To keep one visitor's bucketing across a login, evaluate with the SAME
   * context key on both sides. See "Sharing identity with the web snippet" in
   * the README for the cross-surface version of the same rule.
   */
  alias(previousContext: EvalContext, newContext: EvalContext): void {
    this.s.logger.debug(
      `alias: ${bucketingKey(previousContext)} to ${bucketingKey(newContext)}`
    )
    this.track('avsb_alias', { context: newContext })
  }

  /**
   * Record an exposure for a flag without re-serving its value. Use it when
   * the decision was read earlier with exposures suppressed and the visitor has
   * now actually seen the result.
   */
  manualExposure(flagKey: string, context: EvalContext): void {
    manualExposure(this.s, this, flagKey, context)
  }

  // ---- Per-request scoping ----

  /** A client with the context bound. The primary server pattern. */
  forUser(context: EvalContext): UserBoundClient {
    return createUserBoundClient(this, context)
  }

  /** Ergonomic alias for `forUser`. */
  createUserContext(context: EvalContext): UserBoundClient {
    return createUserBoundClient(this, context)
  }

  // ---- Overrides ----

  setOverrideForUser(
    flagKey: string,
    contextKey: string,
    variationKey: string,
    contextKind: string = 'user'
  ): void {
    this.s.overrides.setForContext(flagKey, contextKey, variationKey, contextKind)
  }

  setGlobalOverride(flagKey: string, variationKey: string): void {
    this.s.overrides.setGlobal(flagKey, variationKey)
  }

  clearOverrideForUser(
    flagKey: string,
    contextKey: string,
    contextKind: string = 'user'
  ): void {
    this.s.overrides.clearForContext(flagKey, contextKey, contextKind)
  }

  clearGlobalOverride(flagKey: string): void {
    this.s.overrides.clearGlobal(flagKey)
  }

  clearAllOverrides(): void {
    this.s.overrides.clearAll()
  }

  /** A fresh decision log to pass per call. `forUser` carries its own. */
  createDecisionLog(): DecisionLog {
    return createDecisionLog()
  }

  // ---- Events ----

  on<E extends ServerEventName>(event: E, cb: ServerEventMap[E]): () => void {
    return addListener(this.s, event, cb)
  }

  off<E extends ServerEventName>(event: E, cb: ServerEventMap[E]): void {
    this.s.listeners.get(event)?.delete(cb)
  }

}
