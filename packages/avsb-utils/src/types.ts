// Shared types for the @avsbhq/utils surface. The `AvsbUtils` interface
// matches the `client.utils.*` shape both Avsb* runtimes expose.

import type {
  Flag,
  EvalContext,
  TrackPayload,
  Logger,
  ClientEventMap,
  DecisionLogEntry,
  FlagDatafile,
} from '@avsbhq/core'
import type { CancelHandle, RetryOptions } from './timing'
import type { FallbackChain } from './resilience'
import type {
  ContextSchema,
  DefinedContextSchema,
  ContextBuilder,
} from './context'
import type {
  BootstrapBlob,
  FlagSnapshot,
  BootstrapFromUrlOptions,
  HydrateBootstrapResult,
  KVNamespace,
} from './snapshots'
import type { GuardedThenable } from './guardedPromise'
import type { CleanupRegistry } from './registry'
import type { DecisionRecorder, DecisionRecorderOptions } from './decisions'
import type { UnifiedStorageAdapter } from './storage'
import type { Transaction, Item } from './track'
import type { SingleContext } from '@avsbhq/core'
import type {
  BrowserOpts,
  DeviceOpts,
  GeoOpts,
  PageOpts,
} from './visitorData'

export interface AvsbUtils {
  // TIMING
  once<F extends (...a: never[]) => unknown>(fn: F): F
  debounce<F extends (...a: never[]) => void>(
    fn: F,
    ms: number
  ): F & CancelHandle
  throttle<F extends (...a: never[]) => void>(
    fn: F,
    ms: number
  ): F & CancelHandle
  retry<T>(fn: () => Promise<T> | T, opts?: RetryOptions): Promise<T>
  sleep(ms: number): Promise<void>
  withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>
  withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T>

  // RESILIENCE
  FallbackChain: typeof FallbackChain
  circuitBreaker<F extends (...a: never[]) => Promise<unknown>>(
    fn: F,
    opts: import('./resilience').CircuitBreakerOptions
  ): F

  // LOG
  log: Logger

  // CONTEXT
  context: {
    defineSchema<S extends ContextSchema>(s: S): DefinedContextSchema<S>
    builder<S extends ContextSchema>(s?: S): ContextBuilder<S>
    merge(a: EvalContext, b: Partial<EvalContext>): EvalContext
    redact(ctx: EvalContext, privateKeys: string[]): EvalContext
    anonymousId(): string
    Browser(opts?: BrowserOpts): SingleContext
    Device(opts?: DeviceOpts): SingleContext
    Geolocation(opts?: GeoOpts): SingleContext
    PageView(opts?: PageOpts): SingleContext
  }

  // SNAPSHOTS
  snapshot(ctx?: EvalContext): FlagSnapshot
  snapshotFresh(ctx?: EvalContext): Promise<FlagSnapshot>
  refreshAndSnapshot(ctx?: EvalContext): Promise<FlagSnapshot>
  serializeBootstrap(
    ctx?: EvalContext,
    opts?: { includeDatafile?: boolean }
  ): Promise<BootstrapBlob>
  hydrateBootstrap(blob: BootstrapBlob): HydrateBootstrapResult
  bootstrapFromUrl(
    url: string,
    opts?: BootstrapFromUrlOptions
  ): Promise<FlagDatafile>
  bootstrapFromKV(kv: KVNamespace, key: string): Promise<FlagDatafile>
  bootstrapFromFile(path: string): Promise<FlagDatafile>
  getServerBootstrap(
    context: EvalContext,
    opts?: { includeDatafile?: boolean }
  ): Promise<BootstrapBlob>

  // CHANGES
  changes(): AsyncIterableIterator<
    ClientEventMap['flagChange'] extends (data: infer D) => unknown ? D : never
  >
  onFlagChange(flagKey: string, cb: (flag: Flag) => void): () => void
  waitForFlag<T = unknown>(
    flagKey: string,
    predicate?: (flag: Flag<T>) => boolean,
    opts?: { timeout?: number; rejectOnTimeout?: boolean }
  ): GuardedThenable<Flag<T>>

  // DECISIONS
  createDecisionRecorder(opts: DecisionRecorderOptions): DecisionRecorder

  // TRACK
  trackBatch(
    events: Array<{ eventKey: string; payload?: TrackPayload }>
  ): void
  trackOnce(
    eventKey: string,
    dedupKey: string,
    payload?: TrackPayload
  ): void
  trackRevenue(
    eventKey: string,
    amount: number,
    currency: string,
    items?: Item[]
  ): void
  trackTransaction(eventKey: string, tx: Transaction): void
  Transaction: typeof Transaction

  // CLEANUP
  registerCleanup(fn: () => void): () => void

  // STORAGE — set on construction; the default is in-memory.
  storage: UnifiedStorageAdapter

  // Diagnostic: how many decisions are buffered, etc.
  /** Drain every registered teardown, called from `client.close()`. */
  _drain(): void
  _registry: CleanupRegistry
  _decisionLog?: DecisionLogEntry[]
}
