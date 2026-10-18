import { notFoundFlag, notReadyFlag } from '@avsbhq/core'
import type {
  ClientEventMap,
  ClientEventName,
  EvalContext,
  Flag,
  InitResult,
  TrackPayload,
} from '@avsbhq/core'
import type { GetFlagOptions, GetAllFlagsOptions } from '@avsbhq/browser'
import type { AngularAvsbClient } from '../clientInterface'
import { NOT_READY_REASON } from '../internal/messages'

/** One recorded read, so a test can assert HOW the adapter read a flag. */
export interface RecordedRead {
  flagKey: string
  options?: GetFlagOptions
}

const EMPTY_FLAGS: Record<string, Flag> = {}

/**
 * A stand-in for `AvsbClient` that honours the parts of the store contract
 * the adapter depends on:
 *
 * - `getSnapshot` returns the SAME object for a key until the value changes,
 *   so identity assertions mean something;
 * - `subscribe` listeners fire on `notify()` and on the ready transition;
 * - a read with `readOnly: true` records no exposure, a read with
 *   `fireExposure: true` records one.
 *
 * Excluded from the published build by `tsconfig.lib.json`.
 */
export class MockAvsbClient implements AngularAvsbClient {
  readonly reads: RecordedRead[] = []
  readonly exposures: string[] = []
  readonly tracked: { eventKey: string; payload?: TrackPayload }[] = []
  readonly identified: EvalContext[] = []
  readonly aliased: { previous: EvalContext; next: EvalContext }[] = []
  resetCount = 0
  closeCount = 0
  flushCount = 0

  private readonly _flags = new Map<string, Flag<unknown>>()
  // Sentinels are cached per key AND per default value, because the real
  // client promises a stable object per (key, default) pair.
  private readonly _notReady = new Map<string, Map<unknown, Flag<unknown>>>()
  private readonly _missing = new Map<string, Map<unknown, Flag<unknown>>>()
  private readonly _flagListeners = new Map<string, Set<() => void>>()
  private readonly _eventListeners = new Map<string, Set<(arg: never) => void>>()
  private _allFlags: Record<string, Flag> = {}
  private _allFlagsDirty = true
  private _ready = false
  private _initResult: InitResult | null = null
  private _context: EvalContext = { kind: 'user', key: 'u_test' }
  private _resolveReady: ((result: InitResult) => void) | null = null
  private readonly _readyPromise = new Promise<InitResult>((resolve) => {
    this._resolveReady = resolve
  })

  constructor(flags: Record<string, Flag<unknown>> = {}) {
    for (const [flagKey, flag] of Object.entries(flags)) {
      this._flags.set(flagKey, flag)
    }
  }

  // -- Test controls -------------------------------------------------------

  /** Publish a value for a key and notify that key's subscribers. */
  setFlag(flagKey: string, flag: Flag<unknown>): void {
    this._flags.set(flagKey, flag)
    this._allFlagsDirty = true
    this.notify(flagKey)
  }

  /** Notify one key's subscribers without changing anything. */
  notify(flagKey: string): void {
    for (const listener of this._flagListeners.get(flagKey) ?? []) listener()
  }

  /** How many store subscribers this key has, for teardown assertions. */
  listenerCount(flagKey: string): number {
    return this._flagListeners.get(flagKey)?.size ?? 0
  }

  /**
   * Settle the init attempt. A successful result makes flags readable, wakes
   * every subscriber (as the real client does when the first datafile lands)
   * and emits 'ready'. A failed one resolves `onReady()` and emits no 'ready'.
   *
   * The real client also emits 'error' on any failed or degraded load, just
   * before it settles. That stays a separate `emitError()` call here on
   * purpose, so a test can order the two events itself and prove the service
   * treats a degraded init as ready-with-warning rather than as fatal.
   */
  settle(result: InitResult): void {
    this._initResult = result
    this._resolveReady?.(result)
    this._resolveReady = null
    if (!result.success) return
    this._ready = true
    this._allFlagsDirty = true
    for (const listeners of this._flagListeners.values()) {
      for (const listener of listeners) listener()
    }
    this.emit('ready', result)
  }

  /** Emit an 'error' event, as the client does before a degraded settle. */
  emitError(error: Error): void {
    this.emit('error', error)
  }

  emit<E extends ClientEventName>(
    event: E,
    arg: Parameters<ClientEventMap[E]>[0]
  ): void {
    for (const listener of this._eventListeners.get(event) ?? []) {
      ;(listener as (value: typeof arg) => void)(arg)
    }
  }

  // -- Lifecycle -----------------------------------------------------------

  /**
   * Resolves when `settle()` is called, and keeps that first answer forever,
   * exactly like the real client.
   */
  onReady(): Promise<InitResult> {
    return this._readyPromise
  }

  isReady(): boolean {
    return this._ready
  }

  getInitResult(): InitResult | null {
    return this._initResult
  }

  close(): Promise<void> {
    this.closeCount += 1
    return Promise.resolve()
  }

  flush(): Promise<void> {
    this.flushCount += 1
    return Promise.resolve()
  }

  // -- Identity ------------------------------------------------------------

  identify(context: EvalContext): void {
    this.identified.push(context)
    this._context = context
  }

  updateAttributes(): void {
    // Not used by the adapter; present to satisfy the interface.
  }

  alias(previous: EvalContext, next: EvalContext): void {
    this.aliased.push({ previous, next })
  }

  getContext(): EvalContext {
    return this._context
  }

  reset(): void {
    this.resetCount += 1
  }

  // -- Reads ---------------------------------------------------------------

  getFlag<T>(flagKey: string, defaultValue: T, options?: GetFlagOptions): Flag<T> {
    this.reads.push({ flagKey, options })
    if (options?.fireExposure === true && options.readOnly !== true) {
      this.exposures.push(flagKey)
    }
    return this._read(flagKey, defaultValue)
  }

  getBoolFlag(
    flagKey: string,
    defaultValue: boolean,
    options?: GetFlagOptions
  ): Flag<boolean> {
    return this.getFlag(flagKey, defaultValue, options)
  }

  getStringFlag(
    flagKey: string,
    defaultValue: string,
    options?: GetFlagOptions
  ): Flag<string> {
    return this.getFlag(flagKey, defaultValue, options)
  }

  getNumberFlag(
    flagKey: string,
    defaultValue: number,
    options?: GetFlagOptions
  ): Flag<number> {
    return this.getFlag(flagKey, defaultValue, options)
  }

  getJsonFlag<T>(
    flagKey: string,
    defaultValue: T,
    options?: GetFlagOptions
  ): Flag<T> {
    return this.getFlag(flagKey, defaultValue, options)
  }

  getAllFlags(_options?: GetAllFlagsOptions): Record<string, Flag> {
    if (!this._ready) return EMPTY_FLAGS
    if (this._allFlagsDirty) {
      this._allFlags = Object.fromEntries(this._flags) as Record<string, Flag>
      this._allFlagsDirty = false
    }
    return this._allFlags
  }

  getSnapshot<T>(flagKey: string, defaultValue: T): Flag<T> {
    this.reads.push({ flagKey, options: { readOnly: true } })
    return this._read(flagKey, defaultValue)
  }

  // -- Events --------------------------------------------------------------

  subscribe(flagKey: string, listener: () => void): () => void {
    let listeners = this._flagListeners.get(flagKey)
    if (!listeners) {
      listeners = new Set()
      this._flagListeners.set(flagKey, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  on<E extends ClientEventName>(event: E, cb: ClientEventMap[E]): () => void {
    let listeners = this._eventListeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this._eventListeners.set(event, listeners)
    }
    const listener = cb as (arg: never) => void
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  track(eventKey: string, payload?: TrackPayload): void {
    this.tracked.push({ eventKey, payload })
  }

  // -- Overrides (unused by the adapter) -----------------------------------

  setOverrideForUser(): void {}
  setGlobalOverride(): void {}
  clearOverrideForUser(): void {}
  clearGlobalOverride(): void {}
  clearAllOverrides(): void {}

  // -- Internals -----------------------------------------------------------

  private _read<T>(flagKey: string, defaultValue: T): Flag<T> {
    if (!this._ready) {
      return this._sentinel(this._notReady, flagKey, defaultValue, () =>
        notReadyFlag<unknown>(defaultValue, NOT_READY_REASON)
      )
    }

    const flag = this._flags.get(flagKey)
    if (flag) return flag as Flag<T>

    return this._sentinel(this._missing, flagKey, defaultValue, () =>
      notFoundFlag<unknown>(defaultValue, 'flag not in datafile')
    )
  }

  private _sentinel<T>(
    cache: Map<string, Map<unknown, Flag<unknown>>>,
    flagKey: string,
    defaultValue: T,
    build: () => Flag<unknown>
  ): Flag<T> {
    let byDefault = cache.get(flagKey)
    if (!byDefault) {
      byDefault = new Map<unknown, Flag<unknown>>()
      cache.set(flagKey, byDefault)
    }
    let flag = byDefault.get(defaultValue)
    if (!flag) {
      flag = build()
      byDefault.set(defaultValue, flag)
    }
    return flag as Flag<T>
  }
}
