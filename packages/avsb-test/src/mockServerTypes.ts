// =====================================================================
// The public shape of `createMockServer`: the whole `AvsbServer` surface
// from @avsbhq/node (N1-10, production QA 2026-10-01), plus `_`-prefixed
// inspection helpers.
//
// Kept apart from the factory so the surface reads in one screen. The
// shapes are structural mirrors of @avsbhq/node's types, declared here so
// this package keeps no runtime or type dependency on @avsbhq/node: a test
// suite that only mocks the server should not have to install it.
// createMockServer.surface.test.ts compares the method names with the real
// class, so a member added to AvsbServer and not here fails there.
// =====================================================================

import type {
  DecideOption,
  DecisionLog,
  EvalContext,
  ExposureEvent,
  Flag,
  FlagDatafile,
  InitResult,
  StickyAssignment,
  TrackPayload,
} from '@avsbhq/core'
import type { AvsbUtils } from '@avsbhq/utils'
import type { MockFlagState } from './mockFlags'

/** Purchase shape mirroring `PurchaseOrder` from @avsbhq/node. */
export interface MockPurchaseOrder {
  orderId: string
  total: number
  currency?: string
  [field: string]: unknown
}

/** Per-call options, mirroring `ServerGetFlagOptions`. Accepted and inert. */
export interface MockServerGetFlagOptions {
  decideOptions?: DecideOption[]
  decisionLog?: DecisionLog
}

/** Mirror of `ServerEventMap` in @avsbhq/node. */
export type MockServerEventMap = {
  ready: () => void
  configUpdate: (data: { publishedAt: string; reason: 'poll' | 'stream' | 'manual' }) => void
  evaluation: (data: { flagKey: string; flag: Flag; contextKeys: string[] }) => void
  exposure: (event: ExposureEvent) => void
  error: (error: Error) => void
  stickyOrphan: (data: { flagKey: string; userId: string; assignment: StickyAssignment }) => void
}

export type MockServerEventName = keyof MockServerEventMap

/** Mirror of `DatasetGetResult` in @avsbhq/node. */
export interface MockDatasetGetResult {
  found: boolean
  value?: unknown
  meta: { slug: string; version: number | null }
}

/** Mirror of `RecProduct` / `RecsGetRequest` / `RecsResult` in @avsbhq/node. */
export interface MockRecProduct {
  id: string
  title?: string
  price?: number
  currency?: string
  [field: string]: unknown
}

export interface MockRecsGetRequest {
  recipe: string
  context?: { seed?: string; seeds?: string[] }
  maxItems?: number
  excludeOutOfStock?: boolean
  attribution?: { visitorId: string; experimentId: string; variationId: string }
}

export interface MockRecsResult {
  items: MockRecProduct[]
  served: boolean
  recipe: string
  source: string | null
  fallbackStep: number | null
  degraded: boolean
}

export interface MockDatasetsClient {
  get(slug: string, key: string): Promise<MockDatasetGetResult>
}

export interface MockRecsClient {
  get(req: MockRecsGetRequest): Promise<MockRecsResult>
  trackClick(
    productId: string,
    opts: { visitorId: string; experimentId: string; variationId: string; position?: number; recipe?: string }
  ): void
}

export interface MockServerOptions extends Partial<MockFlagState> {
  /**
   * Whether the server is already ready (default true). When false every read
   * returns a `not_ready` flag until `_markReady()` is called, which is how you
   * test the pre-ready path a real cold start has.
   */
  ready?: boolean
  /** `server.datasets.get(slug, key)` answers from this: slug, then key, to value. */
  datasets?: Record<string, Record<string, unknown>>
  /** `server.recs.get({ recipe })` answers with these products, by recipe. */
  recs?: Record<string, MockRecProduct[]>
}

export interface MockBoundClient {
  getFlag<T>(flagKey: string, defaultValue: T, options?: MockServerGetFlagOptions): Flag<T>
  getBoolFlag(flagKey: string, defaultValue: boolean, options?: MockServerGetFlagOptions): Flag<boolean>
  getStringFlag(flagKey: string, defaultValue: string, options?: MockServerGetFlagOptions): Flag<string>
  getNumberFlag(flagKey: string, defaultValue: number, options?: MockServerGetFlagOptions): Flag<number>
  getJsonFlag<T>(flagKey: string, defaultValue: T, options?: MockServerGetFlagOptions): Flag<T>
  getAllFlags(): Record<string, Flag>
  track(eventKey: string, payload?: Omit<TrackPayload, 'context'>): void
  trackPurchase(order: MockPurchaseOrder): Promise<void>
  manualExposure(flagKey: string): void
  getContext(): EvalContext
  /** Serve `variationKey` for this flag in this request, with source `runtimeOverride`. */
  setForcedDecision(flagKey: string, opts: { ruleId?: string; variationKey: string }): void
  clearForcedDecision(flagKey: string): void
  getDecisionLog(): DecisionLog
}

export interface MockServer {
  // -- Readiness and lifecycle --------------------------------------------
  onReady(): Promise<InitResult>
  isReady(): boolean
  flush(): Promise<void>
  close(): Promise<void>
  /** Counts the call (see `_refreshCount`) and fires `configUpdate`. */
  refreshDatafile(): Promise<void>
  /** Adopt a datafile: each flag's default variation value joins the flags map. */
  applyDatafileBootstrap(datafile: FlagDatafile): void
  /** The datafile given to `applyDatafileBootstrap`, or null. */
  getDatafile(): FlagDatafile | null

  // -- Evaluation ----------------------------------------------------------
  getFlag<T>(flagKey: string, defaultValue: T, context?: EvalContext, options?: MockServerGetFlagOptions): Flag<T>
  getBoolFlag(flagKey: string, defaultValue: boolean, context?: EvalContext, options?: MockServerGetFlagOptions): Flag<boolean>
  getStringFlag(flagKey: string, defaultValue: string, context?: EvalContext, options?: MockServerGetFlagOptions): Flag<string>
  getNumberFlag(flagKey: string, defaultValue: number, context?: EvalContext, options?: MockServerGetFlagOptions): Flag<number>
  getJsonFlag<T>(flagKey: string, defaultValue: T, context?: EvalContext, options?: MockServerGetFlagOptions): Flag<T>
  getAllFlags(context?: EvalContext, options?: { fireExposures?: boolean; decideOptions?: DecideOption[]; decisionLog?: DecisionLog }): Record<string, Flag>

  // -- Tracking --------------------------------------------------------------
  track(eventKey: string, payload: TrackPayload & { context: EvalContext }): void
  trackPurchase(visitorId: string, order: MockPurchaseOrder): Promise<void>
  /** Records one `avsb_alias` event attributed to the new context, like the real server. */
  alias(previousContext: EvalContext, newContext: EvalContext): void
  manualExposure(flagKey: string, context: EvalContext): void

  // -- Per-request scoping --------------------------------------------------
  forUser(context: EvalContext): MockBoundClient
  createUserContext(context: EvalContext): MockBoundClient

  // -- Runtime overrides ------------------------------------------------------
  setOverrideForUser(flagKey: string, contextKey: string, variationKey: string, contextKind?: string): void
  setGlobalOverride(flagKey: string, variationKey: string): void
  clearOverrideForUser(flagKey: string, contextKey: string, contextKind?: string): void
  clearGlobalOverride(flagKey: string): void
  clearAllOverrides(): void

  // -- Decision logs and events -------------------------------------------------
  createDecisionLog(): DecisionLog
  on<E extends MockServerEventName>(event: E, cb: MockServerEventMap[E]): () => void
  off<E extends MockServerEventName>(event: E, cb: MockServerEventMap[E]): void

  // -- Sub-clients --------------------------------------------------------------
  /** The real `createUtils` helpers, bound to this mock. */
  readonly utils: AvsbUtils
  /** Answers from `options.datasets`. */
  readonly datasets: MockDatasetsClient
  /** Answers from `options.recs`; clicks land in `_recClicks()`. */
  readonly recs: MockRecsClient

  // -- Inspection (test-only) ------------------------------------------------------
  /** Change a flag's fallthrough value mid-test. */
  _setFlag(flagKey: string, value: unknown): void
  /** Every track call, with the context it was attributed to. */
  _tracked(): Array<{ eventKey: string; payload: TrackPayload | undefined; contextKey: string }>
  /** Every purchase, with the visitor it was attributed to. */
  _purchases(): Array<{ visitorId: string; order: MockPurchaseOrder }>
  /** Every evaluation. */
  _evaluations(): Array<{ flagKey: string; value: unknown; contextKey: string }>
  /** Every exposure recorded, including manual ones. */
  _exposures(): Array<{ flagKey: string; contextKey: string; manual: boolean }>
  /** Every `recs.trackClick` call. */
  _recClicks(): Array<{ productId: string; recipe: string | undefined; visitorId: string }>
  /** How many times `refreshDatafile()` was called. */
  _refreshCount(): number
  /** Become ready, resolving `onReady` and firing `ready`. */
  _markReady(result?: InitResult): void
}
