// The mutable state of one AvsbClient, in one object the split-out modules
// share (FU-31). AvsbClient holds it privately; clientDatafile,
// clientEvaluation, clientTracking, clientEvents and clientPersistence read
// and write it. Nothing here is exported from the package entry.

import type {
  AvsbClientOptions,
  SdkWrapperIdentity,
  BrowserEventOptions,
  Tracker,
} from './types'
import type {
  EvalContext,
  Flag,
  InitResult,
  TrackPayload,
  ExposureEvent,
  FlagDatafile,
  Logger,
  EventBus,
} from '@avsbhq/core'
import { createEventBus, DEFAULT_CDN_HOST } from '@avsbhq/core'
import type { StreamingClient } from '@avsbhq/utils/streaming'
// VALUE import, so it must come from the browser-safe leaf and never from the
// root barrel: the root pulls `node:async_hooks` and a file-bootstrap `fs`
// import, and a customer bundling this package for the web fails to resolve
// either.
import { createSnapshotStore } from '@avsbhq/utils/snapshot'
import type { SnapshotStore } from '@avsbhq/utils/snapshot'
import { resolveLogger } from './logger'
import { validateSdkKeyShape } from './sdkKeyShape'
import { buildContextFromOptions, resolveVisitorId } from './identity'
import { DEFAULT_CACHE_MAX_AGE_MS } from './datafileCache'
import { createSnapshotCache, type SnapshotCache } from './snapshotCache'
import { createOverrideStore, type OverrideStore } from './overrideStore'
import type { PollingLoop } from './polling'

const DEFAULT_POLLING_INTERVAL = 60_000
const DEFAULT_INIT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_PENDING_EVENTS = 100

function normaliseCdnHost(host: string): string {
  return host.endsWith('/') ? host.slice(0, -1) : host
}

/** What triggered a datafile refresh. Mirrors `configUpdate.reason`. */
export type RefreshReason = 'poll' | 'stream' | 'manual'

/** Why the current datafile is in memory. Drives InitResult and logs. */
export type DatafileSource = 'bootstrap' | 'cache' | 'network' | RefreshReason

export interface PendingTrackEvent {
  eventKey: string
  payload?: TrackPayload
}

/**
 * One entry of the value cache that drives change detection.
 *
 * `value` decides whether `flagChange` fires (a customer cares that the
 * value moved). `signature` decides whether the cached snapshot object is
 * still valid, and covers the metadata a snapshot also carries: a rule
 * reorder that keeps the same value still changes `ruleId`, and an adapter
 * showing the decision path would otherwise render a stale one.
 */
export interface FlagCacheEntry {
  value: unknown
  signature: string
}

export interface ClientState {
  // ---- core config ----
  readonly sdkKey: string
  /** The wrapping framework package, reported on the heartbeat (N1-14). */
  readonly wrapper: SdkWrapperIdentity | undefined
  readonly pollingIntervalMs: number
  readonly autoRefresh: boolean
  readonly cdnHost: string
  readonly logger: Logger
  readonly onError?: (
    e: Error,
    source: 'init' | 'poll' | 'stream' | 'track' | 'eval'
  ) => void
  readonly streamingEnabled: boolean
  readonly streamingEndpointOption: string | null
  readonly initTimeoutMs: number
  readonly cacheEnabled: boolean
  readonly cacheMaxAgeMs: number
  readonly maxPendingEvents: number
  readonly eventOptions: BrowserEventOptions
  readonly pauseWhenHidden: boolean
  readonly refetchOnFocus: boolean
  readonly adoptSnippetVisitorId: boolean

  // ---- runtime state ----
  context: EvalContext
  anonymousId: string
  datafile: FlagDatafile | null
  datafileSource: DatafileSource | null
  datafileEtag: string | null
  ready: boolean
  closed: boolean
  initStarted: boolean
  initResult: InitResult | null

  // onReady() promise. Created with the state so it is the same promise
  // whether the caller awaits before or after init settles.
  readonly readyPromise: Promise<InitResult>
  readyResolve: ((result: InitResult) => void) | null

  polling: PollingLoop | null
  tracker: Tracker | null
  /**
   * Third-party exposure forwarder (analytics integrations D-10). Stays null
   * unless the datafile carries an `integrations` block naming a destination
   * this SDK can reach. See ensureTracker.
   */
  forwardExposure: ((event: ExposureEvent) => void) | null
  flagCache: Record<string, FlagCacheEntry>
  pendingEvents: PendingTrackEvent[]
  streamingClient: StreamingClient | null

  // ---- event bus (§5.14-adjacent) ----
  readonly bus: EventBus

  // ---- per-flag subscriptions for useSyncExternalStore (§5.14) ----
  readonly flagSubscribers: Map<string, Set<() => void>>

  // ---- referentially stable snapshots (report 03 handoff 1) ----
  readonly snapshots: SnapshotCache
  allFlagsSnapshot: Record<string, Flag> | null

  /**
   * Server-evaluated values adopted through `applySnapshot`, answering reads
   * until a real datafile is readable. Empty on every client that does not use
   * the SSR bootstrap path.
   */
  readonly snapshotBootstrap: SnapshotStore

  // ---- overrides (§5.9) ----
  readonly overrides: OverrideStore

  /** Keys of one-time warnings, so a render loop cannot flood the console. */
  readonly warnedOnce: Set<string>
}

/**
 * Resolve the options into a fresh state, with the side effects in the
 * order the constructor always ran them: logger, event bus, the key shape
 * check (which logs an unrecognised key), then the persisted visitor id.
 * Serving a bootstrap or cached datafile and starting init are left to the
 * constructor.
 */
export function createClientState(options: AvsbClientOptions): ClientState {
  const logger = resolveLogger(options)
  const bus = createEventBus((event, err) => {
    logger.warn('event listener threw', { event, error: err.message })
  })

  // Loud, actionable, and non-fatal: a key we do not recognise may still
  // be valid, so the fetch stays the arbiter (spec §1.2).
  const keyShape = validateSdkKeyShape(options.sdkKey)
  if (!keyShape.valid && keyShape.message) {
    logger.error(keyShape.message)
  }

  // Persisted anonymous identity, adopting the snippet's visitor id when
  // Web Experiments is installed on the same page (report 02 §5.5).
  const adoptSnippetVisitorId = options.adoptSnippetVisitorId !== false
  const visitor = resolveVisitorId({ adoptSnippetVisitorId, logger })

  let readyResolve: ((result: InitResult) => void) | null = null
  const readyPromise = new Promise<InitResult>((resolve) => {
    readyResolve = resolve
  })

  return {
    sdkKey: options.sdkKey,
    wrapper: options.wrapper,
    pollingIntervalMs: options.pollingInterval ?? DEFAULT_POLLING_INTERVAL,
    autoRefresh: options.autoRefresh ?? true,
    cdnHost: normaliseCdnHost(options.cdnHost ?? DEFAULT_CDN_HOST),
    logger,
    onError: options.onError,
    streamingEnabled: options.streaming === true,
    streamingEndpointOption: options.streamingEndpoint ?? null,
    initTimeoutMs: options.initTimeout ?? DEFAULT_INIT_TIMEOUT_MS,
    cacheEnabled: options.cache !== false,
    cacheMaxAgeMs: options.cacheMaxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS,
    maxPendingEvents: Math.max(1, options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS),
    eventOptions: options.events ?? {},
    pauseWhenHidden: options.pauseWhenHidden !== false,
    refetchOnFocus: options.refetchOnFocus !== false,
    adoptSnippetVisitorId,

    context: buildContextFromOptions({
      context: options.context,
      anonymousId: visitor.id,
    }),
    anonymousId: visitor.id,
    datafile: null,
    datafileSource: null,
    datafileEtag: null,
    ready: false,
    closed: false,
    initStarted: false,
    initResult: null,
    readyPromise,
    readyResolve,
    polling: null,
    tracker: null,
    forwardExposure: null,
    flagCache: {},
    pendingEvents: [],
    streamingClient: null,
    bus,
    flagSubscribers: new Map(),
    snapshots: createSnapshotCache(),
    allFlagsSnapshot: null,
    snapshotBootstrap: createSnapshotStore(),
    overrides: createOverrideStore(),
    warnedOnce: new Set<string>(),
  }
}

export function warnOnce(s: ClientState, key: string, message: string): void {
  if (s.warnedOnce.has(key)) return
  s.warnedOnce.add(key)
  s.logger.warn(message)
}
