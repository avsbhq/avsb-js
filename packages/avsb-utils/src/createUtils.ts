// createUtils — binds every helper to a registry + scope and returns the
// `AvsbUtils` shape that both browser and server clients expose as
// `client.utils.*`.

import type {
  Logger,
  EvalContext,
  Flag,
  TrackPayload,
  ClientEventMap,
  FlagDatafile,
} from '@avsbhq/core'
import { createRegistry, type CleanupRegistry } from './registry'
import {
  debounce as _debounce,
  once as _once,
  retry as _retry,
  sleep as _sleep,
  throttle as _throttle,
  withDeadline as _withDeadline,
  withTimeout as _withTimeout,
} from './timing'
import { FallbackChain, circuitBreaker as _circuitBreaker } from './resilience'
import {
  defineContextSchema,
  mergeContext,
  redactAttributes,
  anonymousId,
} from './context'
import { Browser, Device, Geolocation, PageView } from './visitorData'
import {
  bootstrapFromFile,
  bootstrapFromKV,
  bootstrapFromUrl,
  getServerBootstrap as _getServerBootstrap,
  hydrateBootstrap as _hydrateBootstrap,
  refreshAndSnapshot as _refreshAndSnapshot,
  serializeBootstrap as _serializeBootstrap,
  snapshot as _snapshot,
  snapshotFresh as _snapshotFresh,
  type BootstrapTarget,
  type SnapshotClient,
} from './snapshots'
import { createChanges, type ChangeClient } from './changes'
import { createDecisionRecorder } from './decisions'
import { createTrack, Transaction, type TrackClient } from './track'
import { createMemoryAdapter, type UnifiedStorageAdapter } from './storage'
import type { AvsbUtils } from './types'

export interface CreateUtilsClient
  extends ChangeClient,
    SnapshotClient,
    TrackClient,
    BootstrapTarget {
  getFlag<T = unknown>(flagKey: string, defaultValue: T): Flag<T>
  on<E extends keyof ClientEventMap>(
    event: E,
    cb: ClientEventMap[E]
  ): () => void
  track(eventKey: string, payload?: TrackPayload): void
  getAllFlags(opts?: {
    context?: EvalContext
    fireExposures?: boolean
  }): Record<string, Flag>
  getDatafile?(): FlagDatafile | null
  getCurrentContext?(): EvalContext | null
  refresh?(): Promise<void>
  applyDatafile?(df: FlagDatafile): void
  applySnapshot?(snap: import('./snapshots').FlagSnapshot): void
}

export interface CreateUtilsOptions {
  logger?: Logger
  storage?: UnifiedStorageAdapter
  registry?: CleanupRegistry
}

export function createUtils(
  client: CreateUtilsClient,
  opts: CreateUtilsOptions = {}
): AvsbUtils {
  const registry = opts.registry ?? createRegistry()
  const log = opts.logger ?? clientLogger()
  const storage = opts.storage ?? createMemoryAdapter()
  const changes = createChanges(client, registry, log)
  const track = createTrack(client, registry, log)

  return {
    // Timing
    once: _once,
    debounce: (fn, ms) => _debounce(fn, ms, registry),
    throttle: (fn, ms) => _throttle(fn, ms, registry),
    retry: _retry,
    sleep: _sleep,
    withTimeout: _withTimeout,
    withDeadline: _withDeadline,

    // Resilience
    FallbackChain,
    circuitBreaker: _circuitBreaker,

    // Log
    log,

    // Context
    context: {
      defineSchema: defineContextSchema,
      builder: <S extends Record<string, unknown>>(_s?: S) =>
        defineContextSchema(
          (_s ?? {}) as Parameters<typeof defineContextSchema>[0]
        ).builder() as unknown as ReturnType<
          AvsbUtils['context']['builder']
        >,
      merge: mergeContext,
      redact: redactAttributes,
      anonymousId,
      Browser,
      Device,
      Geolocation,
      PageView,
    },

    // Snapshots
    snapshot: (ctx) => _snapshot(client, ctx),
    snapshotFresh: (ctx) => _snapshotFresh(client, ctx),
    refreshAndSnapshot: (ctx) => _refreshAndSnapshot(client, ctx),
    serializeBootstrap: (ctx, sopts) => _serializeBootstrap(client, ctx, sopts),
    hydrateBootstrap: (blob) => _hydrateBootstrap(client, blob),
    bootstrapFromUrl,
    bootstrapFromKV,
    bootstrapFromFile,
    getServerBootstrap: (ctx, sopts) => _getServerBootstrap(client, ctx, sopts),

    // Changes
    changes: changes.changes,
    onFlagChange: changes.onFlagChange,
    waitForFlag: changes.waitForFlag,

    // Decisions
    createDecisionRecorder,

    // Track
    trackBatch: track.trackBatch,
    trackOnce: track.trackOnce,
    trackRevenue: track.trackRevenue,
    trackTransaction: track.trackTransaction,
    Transaction,

    // Cleanup
    registerCleanup: (fn) => registry.add(fn),

    // Storage
    storage,

    // Internals
    _drain: () => registry.drain(),
    _registry: registry,
  }
}

function clientLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => clientLogger(),
  }
}
