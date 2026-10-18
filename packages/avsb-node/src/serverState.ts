// The mutable state of one AvsbServer, in one object the split-out modules
// share (FU-31). AvsbServer holds it privately; serverDatafile,
// serverEvaluation, serverDecision, serverTracking and serverStreaming read
// and write it. Nothing here is exported from the package entry.

import type {
  DecideOption,
  EvalContext,
  ExposureEvent,
  FlagDatafile,
  InitResult,
  Logger,
  StickyBucketService,
  TrackPayload,
} from '@avsbhq/core'
import { validateSdkKeyShape } from '@avsbhq/utils/sdkKey'
import { createDecideOptionResolver } from './decideOptions'
import type { ResolvedDecideOptions } from './decideOptions'
import { createOverrideStore } from './overrideStore'
import type { OverrideStore } from './overrideStore'
import { acceptDatafile } from './datafileSource'
import { resolveServerLogger } from './logger'
import type { PurchaseOrder, ServerTracker } from './serverTracker'
import type { StreamingClient } from './streaming'
import type {
  AvsbServerOptions,
  ServerEventMap,
  ServerEventName,
  ServerGetFlagOptions,
} from './types'
import type { AvsbServer } from './AvsbServer'

/**
 * @internal Superset of the public per-call options, carrying the two things
 * only this package may set. Not exported from the package entry.
 */
export interface InternalGetFlagOptions extends ServerGetFlagOptions {
  /** Forced decision from a UserBoundClient, applied before evaluation. */
  forcedVariationKey?: string
  /** Runtime type check to apply, from a typed getter. */
  expectedType?: 'boolean' | 'string' | 'number' | 'json'
}

export interface ResolvedEventOptions {
  flushInterval: number
  batchSize: number
  maxQueueSize: number
  retryAttempts: number
}

const DEFAULT_EVENTS: ResolvedEventOptions = {
  flushInterval: 2000,
  batchSize: 10,
  maxQueueSize: 10_000,
  retryAttempts: 3,
}

/** Pre-ready queue entries, drained in order once the tracker exists. */
export interface PendingTrackEvent {
  eventKey: string
  payload: TrackPayload & { context: EvalContext }
}
export interface PendingPurchase {
  visitorId: string
  order: PurchaseOrder
}

export interface ServerState {
  readonly sdkKey: string
  readonly cdnHost: string | undefined
  readonly pollingInterval: number
  readonly initTimeout: number
  readonly logger: Logger
  readonly stickyBucketService: StickyBucketService | null
  readonly eventOptions: ResolvedEventOptions
  readonly streamingEnabled: boolean
  readonly streamingEndpointOption: string | null
  readonly overrides: OverrideStore
  readonly resolveDecideOptions: (
    options: readonly DecideOption[] | undefined
  ) => ResolvedDecideOptions

  datafile: FlagDatafile | null
  datafileEtag: string | null
  ready: boolean
  destroyed: boolean
  tracker: ServerTracker | null
  streamingClient: StreamingClient | null
  pollingTimer: ReturnType<typeof setTimeout> | null
  readonly abortController: AbortController
  readonly listeners: Map<ServerEventName, Set<unknown>>
  readyPromise: Promise<InitResult> | null
  pendingEvents: PendingTrackEvent[]
  pendingPurchases: PendingPurchase[]
  /**
   * Exposures produced before the tracker existed. Third member of the
   * pre-ready family alongside `pendingEvents` and `pendingPurchases`; it used
   * to be missing, and exposures were dropped on the floor instead.
   */
  pendingExposures: ExposureEvent[]
  /** ms-epoch of the last liveness heartbeat, for the throttle. */
  lastHeartbeatAt: number
  /** Keys of one-time warnings, so a request loop cannot flood a log. */
  readonly warnedOnce: Set<string>
}

/**
 * Resolve the options into a fresh state, in the order the constructor always
 * ran: logger, bootstrap check (which logs a refused bootstrap), then the key
 * shape check (which logs an unrecognised key). Building the tracker for a
 * bootstrapped client is left to the constructor.
 */
export function createServerState(options: AvsbServerOptions): ServerState {
  const logger = resolveServerLogger(options)
  // A malformed bootstrap is refused with a logged reason (N0-15), so the
  // SDK starts not ready and loads from the CDN instead of throwing later.
  const datafile = options.bootstrap
    ? acceptDatafile(options.bootstrap, 'bootstrap', logger)
    : null
  const state: ServerState = {
    sdkKey: options.sdkKey,
    pollingInterval: Math.max(options.pollingInterval ?? 60_000, 5_000),
    cdnHost: options.cdnHost,
    initTimeout: options.initTimeout ?? 10_000,
    logger,
    stickyBucketService: options.stickyBucketService ?? null,
    eventOptions: { ...DEFAULT_EVENTS, ...options.events },
    // Streaming is ON by default on the server (B12). Resolution happens once
    // a datafile exists, because the endpoint is a datafile field.
    streamingEnabled: options.streaming !== false,
    streamingEndpointOption: options.streamingEndpoint ?? null,
    overrides: createOverrideStore(),
    resolveDecideOptions: createDecideOptionResolver(logger),
    datafile,
    datafileEtag: null,
    ready: datafile !== null,
    destroyed: false,
    tracker: null,
    streamingClient: null,
    pollingTimer: null,
    abortController: new AbortController(),
    listeners: new Map<ServerEventName, Set<unknown>>(),
    readyPromise: null,
    pendingEvents: [],
    pendingPurchases: [],
    pendingExposures: [],
    lastHeartbeatAt: 0,
    warnedOnce: new Set<string>(),
  }

  // Loud, actionable, and non-fatal: a key we do not recognise may still be
  // valid, so the datafile fetch stays the arbiter (spec §1.2).
  const keyShape = validateSdkKeyShape(state.sdkKey)
  if (!keyShape.valid && keyShape.message) {
    logger.error(keyShape.message)
  }
  return state
}

export function warnOnce(s: ServerState, key: string, message: string): void {
  if (s.warnedOnce.has(key)) return
  s.warnedOnce.add(key)
  s.logger.warn(message)
}

export function emit<E extends ServerEventName>(
  s: ServerState,
  event: E,
  ...args: Parameters<ServerEventMap[E]>
): void {
  const cbs = s.listeners.get(event)
  if (!cbs) return
  for (const cb of cbs) {
    try {
      ;(cb as (...a: Parameters<ServerEventMap[E]>) => void)(...args)
    } catch (e) {
      s.logger.error('Listener error', { event, error: String(e) })
    }
  }
}

/** The body of `AvsbServer.on`. */
export function addListener<E extends ServerEventName>(
  s: ServerState,
  event: E,
  cb: ServerEventMap[E]
): () => void {
  if (!s.listeners.has(event)) s.listeners.set(event, new Set())
  // The line above guarantees a set for this event.
  s.listeners.get(event)!.add(cb)
  return () => {
    s.listeners.get(event)?.delete(cb)
  }
}

/**
 * `on` for the shared `ClientEventMap` names the utils layer speaks. The
 * server emits every one of them except `flagChange`, which needs per-flag
 * diffing the server does not do; subscribing to it warns and hands back a
 * no-op disposer instead of pretending.
 */
export function onSharedEvent(
  s: ServerState,
  server: AvsbServer,
  event: string,
  cb: unknown
): () => void {
  if (event === 'flagChange') {
    warnOnce(
      s,
      'no-flag-change',
      'The server SDK does not emit "flagChange": it holds one datafile for the ' +
        'whole process and does not diff individual flags. Subscribe to ' +
        '"configUpdate" for "a new datafile was published" instead.'
    )
    return () => undefined
  }
  return server.on(
    event as ServerEventName,
    cb as ServerEventMap[ServerEventName]
  )
}
