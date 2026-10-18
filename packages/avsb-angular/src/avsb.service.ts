import { Injectable, inject } from '@angular/core'
import type { OnDestroy, Signal } from '@angular/core'
import { toSignal } from '@angular/core/rxjs-interop'
import { Observable, distinctUntilChanged, map } from 'rxjs'
import type { AvsbFlagKey, Flag, EvalContext, InitResult, TrackPayload } from '@avsbhq/core'
import { AVSB_CLIENT, AVSB_CONFIG } from './avsb.tokens'
import type { AngularAvsbClient } from './clientInterface'
import type { AvsbInjectOptions, AvsbStatus } from './types'
import {
  flagStream,
  readBool,
  readJson,
  readNumber,
  readSnapshot,
  readString,
} from './internal/flagStream'
import { NO_CLIENT_MESSAGE } from './internal/messages'
import { AvsbStatusStore } from './internal/statusStore'

/** Returned where a caller may hold a canceller that has nothing left to do. */
const NOOP = (): void => {}

/**
 * The A vs B SDK, as an Angular service.
 *
 * Provided by `provideAvsb()` or `AvsbModule.forRoot()`. Injecting it into an
 * application that configured neither throws, naming the call to add.
 *
 * Every read here is render-safe: it fires no exposure event, and it returns
 * the same `Flag` object until that flag's value changes. Record the exposure
 * where the decision is actually shown, with `recordExposure()` or the
 * `[avsbExposure]` directive.
 */
@Injectable({ providedIn: 'root' })
export class AvsbService implements OnDestroy {
  private readonly _state = new AvsbStatusStore()

  /** `'loading' | 'ready' | 'error'`, as a signal. */
  readonly status: Signal<AvsbStatus> = this._state.status
  /** The same value as `status`, as an Observable. */
  readonly status$: Observable<AvsbStatus> = this._state.status$

  /** `true` once `status` is `'ready'`, as a signal. */
  readonly ready: Signal<boolean> = this._state.ready
  /** `true` once `status` is `'ready'`, as an Observable. */
  readonly ready$: Observable<boolean> = this._state.ready$

  /**
   * True while the SDK serves stale-but-real values: a cached datafile is
   * loaded and a refresh of it failed. Flags work, they may be out of date.
   * This is a warning, never fatal, and `status` stays `'ready'`.
   */
  readonly degraded: Signal<boolean> = this._state.degraded
  /** The same value as `degraded`, as an Observable. */
  readonly degraded$: Observable<boolean> = this._state.degraded$

  /**
   * The last error the SDK produced. Its message names what failed, the
   * value involved, and where to fix it. Non-null when `status` is `'error'`
   * (fatal: every flag answers with your default) and when `degraded` is
   * true (values are stale, not wrong).
   */
  readonly error: Signal<Error | null> = this._state.error
  /** The same value as `error`, as an Observable. */
  readonly error$: Observable<Error | null> = this._state.error$

  /**
   * The underlying client, for the surface this service does not wrap:
   * runtime overrides, `updateAttributes`, `getContext`.
   */
  readonly client: AngularAvsbClient

  /** True only in Mode A, where this package built the client. */
  private readonly _ownsClient: boolean
  private _destroyed = false
  private readonly _teardown: (() => void)[] = []

  /**
   * Takes no arguments on purpose: both tokens come from `inject()` in the
   * body, so there is no constructor metadata for Angular to reflect over and
   * no build mode where the two disagree. To build one in a test, run
   * `new AvsbService()` inside `runInInjectionContext` with an injector
   * carrying `AVSB_CLIENT` and `AVSB_CONFIG` (see the README, section 12).
   */
  constructor() {
    const client = inject(AVSB_CLIENT, { optional: true })
    const config = inject(AVSB_CONFIG, { optional: true })

    if (!client) throw new Error(NO_CLIENT_MESSAGE)

    this.client = client
    this._ownsClient =
      config != null && !('client' in config && config.client !== undefined)

    this._adoptCurrentState()
    this._watchClient()
  }

  // -------------------------------------------------------------------------
  // Readiness
  // -------------------------------------------------------------------------

  /** Synchronous: can flags be read right now? */
  isReady(): boolean {
    return this.client.isReady()
  }

  /**
   * Resolves when the init attempt settles. Never rejects, so no `try` is
   * needed: read `result.success`. `timeout` bounds how long you wait, not
   * what the SDK does.
   */
  onReady(options?: { timeout?: number }): Promise<InitResult> {
    return this.client.onReady(options)
  }

  // -------------------------------------------------------------------------
  // Reading flags: Observables
  // -------------------------------------------------------------------------

  /** One flag, no runtime type check. Emits immediately, then on change. */
  getFlag<T>(flagKey: AvsbFlagKey, defaultValue: T): Observable<Flag<T>> {
    return flagStream<T>(this.client, flagKey, defaultValue, readSnapshot)
  }

  /** Just the value of one flag, for callers that do not need the metadata. */
  getFlagValue<T>(flagKey: AvsbFlagKey, defaultValue: T): Observable<T> {
    return this.getFlag<T>(flagKey, defaultValue).pipe(map((flag) => flag.value))
  }

  /** One boolean flag. A non-boolean value falls back to `defaultValue`. */
  getBoolFlag(flagKey: AvsbFlagKey, defaultValue: boolean): Observable<Flag<boolean>> {
    return flagStream(this.client, flagKey, defaultValue, readBool)
  }

  /** One string flag. A non-string value falls back to `defaultValue`. */
  getStringFlag(flagKey: AvsbFlagKey, defaultValue: string): Observable<Flag<string>> {
    return flagStream(this.client, flagKey, defaultValue, readString)
  }

  /** One number flag. A non-number value falls back to `defaultValue`. */
  getNumberFlag(flagKey: AvsbFlagKey, defaultValue: number): Observable<Flag<number>> {
    return flagStream(this.client, flagKey, defaultValue, readNumber)
  }

  /**
   * One JSON flag. `T` is not validated at runtime, only that the platform
   * declared the flag as JSON. Validate the payload yourself if it crosses a
   * trust boundary.
   */
  getJsonFlag<T>(flagKey: AvsbFlagKey, defaultValue: T): Observable<Flag<T>> {
    return flagStream<T>(this.client, flagKey, defaultValue, readJson)
  }

  /**
   * Every flag in the datafile, keyed by flag key. Emits immediately, then
   * once per change. Before the SDK is ready this emits `{}`.
   */
  getAllFlags(): Observable<Record<string, Flag>> {
    return new Observable<Record<string, Flag>>((subscriber) => {
      subscriber.next(this.client.getAllFlags())
      const unsubscribe = this.client.on('flagChange', () => {
        if (subscriber.closed) return
        subscriber.next(this.client.getAllFlags())
      })
      return () => {
        unsubscribe()
      }
    }).pipe(
      // The client hands back the same object until something changes, so
      // the burst of per-flag events on the first datafile collapses to one.
      distinctUntilChanged()
    )
  }

  /**
   * A synchronous render-safe read, for code that cannot subscribe. Same
   * object until the value changes, and no exposure.
   */
  snapshot<T>(flagKey: AvsbFlagKey, defaultValue: T): Flag<T> {
    return this.client.getSnapshot<T>(flagKey, defaultValue)
  }

  // -------------------------------------------------------------------------
  // Reading flags: Signals. Each needs an injection context (a field
  // initializer, a constructor, a factory) or an explicit `injector`, which
  // is also what decides when the subscription is released.
  // -------------------------------------------------------------------------

  /** One flag as a signal. */
  flagSignal<T>(
    flagKey: AvsbFlagKey,
    defaultValue: T,
    options?: AvsbInjectOptions
  ): Signal<Flag<T>> {
    return this._toSignal(this.getFlag<T>(flagKey, defaultValue), options)
  }

  /** Just the value of one flag, as a signal. */
  flagValueSignal<T>(
    flagKey: AvsbFlagKey,
    defaultValue: T,
    options?: AvsbInjectOptions
  ): Signal<T> {
    return this._toSignal(this.getFlagValue<T>(flagKey, defaultValue), options)
  }

  /** One boolean flag as a signal. */
  boolFlagSignal(
    flagKey: AvsbFlagKey,
    defaultValue: boolean,
    options?: AvsbInjectOptions
  ): Signal<Flag<boolean>> {
    return this._toSignal(this.getBoolFlag(flagKey, defaultValue), options)
  }

  /** One string flag as a signal. */
  stringFlagSignal(
    flagKey: AvsbFlagKey,
    defaultValue: string,
    options?: AvsbInjectOptions
  ): Signal<Flag<string>> {
    return this._toSignal(this.getStringFlag(flagKey, defaultValue), options)
  }

  /** One number flag as a signal. */
  numberFlagSignal(
    flagKey: AvsbFlagKey,
    defaultValue: number,
    options?: AvsbInjectOptions
  ): Signal<Flag<number>> {
    return this._toSignal(this.getNumberFlag(flagKey, defaultValue), options)
  }

  /** One JSON flag as a signal. */
  jsonFlagSignal<T>(
    flagKey: AvsbFlagKey,
    defaultValue: T,
    options?: AvsbInjectOptions
  ): Signal<Flag<T>> {
    return this._toSignal(this.getJsonFlag<T>(flagKey, defaultValue), options)
  }

  /** Every flag in the datafile, as a signal. */
  allFlagsSignal(options?: AvsbInjectOptions): Signal<Record<string, Flag>> {
    return this._toSignal(this.getAllFlags(), options)
  }

  // -------------------------------------------------------------------------
  // Exposure
  // -------------------------------------------------------------------------

  /**
   * Record that this visitor was shown the decision for `flagKey`.
   *
   * Reads through this service are deliberately exposure-free, so results
   * cannot be inflated by change detection. Call this once, where the
   * variation is actually shown. In templates, use `[avsbExposure]`.
   *
   * Called before the SDK is ready, it waits for the first datafile and
   * fires then; nothing is recorded if the datafile never loads, because
   * there was no decision to record.
   *
   * @returns a cancel function for that waiting case (a component destroyed
   *   before the datafile arrived). It does nothing once the exposure fired.
   */
  recordExposure(flagKey: AvsbFlagKey, defaultValue: unknown = null): () => void {
    if (this._destroyed) return NOOP

    if (this.client.isReady()) {
      this.client.getFlag(flagKey, defaultValue, { fireExposure: true })
      return NOOP
    }

    let cancelled = false
    const off = this.client.on('ready', () => {
      off()
      if (cancelled || this._destroyed) return
      this.client.getFlag(flagKey, defaultValue, { fireExposure: true })
    })
    this._teardown.push(off)

    return () => {
      cancelled = true
      off()
    }
  }

  // -------------------------------------------------------------------------
  // Identity and events
  // -------------------------------------------------------------------------

  /** Replace the evaluation context. Every flag re-evaluates immediately. */
  identify(context: EvalContext): void {
    this.client.identify(context)
  }

  /**
   * Link an anonymous context to an identified one. Call once, at sign-in,
   * AFTER `identify(newContext)`: the event is attributed to whatever the
   * client is bound to.
   *
   * Synchronous, because it queues one event rather than waiting for a
   * round trip.
   */
  alias(previousContext: EvalContext, newContext: EvalContext): void {
    this.client.alias(previousContext, newContext)
  }

  /** Drop the current identity and start a fresh anonymous one. */
  reset(): void {
    this.client.reset()
  }

  /** Record a conversion event. */
  track(eventKey: string, payload?: TrackPayload): void {
    this.client.track(eventKey, payload)
  }

  /** Send queued events now. Resolves when the send settles. */
  flush(): Promise<void> {
    return this.client.flush()
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /**
   * Release listeners, and close the client in Mode A. Angular calls this
   * through `ngOnDestroy` when the injector that provided the service is
   * destroyed, so applications rarely call it directly.
   */
  destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    for (const off of this._teardown) off()
    this._teardown.length = 0
    if (this._ownsClient) void this.client.close().catch(() => {})
  }

  ngOnDestroy(): void {
    this.destroy()
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _toSignal<T>(
    source: Observable<T>,
    options?: AvsbInjectOptions
  ): Signal<T> {
    // Every stream on this service emits synchronously on subscribe, so
    // `requireSync` always holds and the signal type carries no `undefined`
    // for the caller to narrow away.
    const injector = options?.injector
    return injector
      ? toSignal(source, { requireSync: true, injector })
      : toSignal(source, { requireSync: true })
  }

  /** Seed the status from what the client already knows, before any event. */
  private _adoptCurrentState(): void {
    const settled = this.client.getInitResult()
    if (settled) {
      this._state.applyInitResult(settled)
      return
    }
    // A bootstrap or a cached datafile makes flags readable while the first
    // network attempt is still in flight.
    if (this.client.isReady()) this._state.markReadable()
  }

  private _watchClient(): void {
    // 'ready' fires on every successful settle, including the case where a
    // later refresh rescues a failed init, so it is the authority on status.
    this._teardown.push(
      this.client.on('ready', (result: InitResult) => {
        if (!this._destroyed) this._state.applyInitResult(result)
      })
    )

    // A degraded init emits 'error' and THEN settles successfully. Treating
    // that event as fatal is what made a working, slightly stale SDK look
    // broken, so here it only records the reason.
    this._teardown.push(
      this.client.on('error', (error: Error) => {
        if (!this._destroyed) this._state.recordError(error)
      })
    )

    void this.client.onReady().then((result) => {
      if (!this._destroyed) this._state.applyInitResult(result)
    })
  }
}
