import { signal } from '@angular/core'
import type { Signal } from '@angular/core'
import { BehaviorSubject, Observable, distinctUntilChanged, map } from 'rxjs'
import type { InitResult } from '@avsbhq/core'
import type { AvsbStatus } from '../types'
import { INIT_FAILED_MESSAGE } from './messages'

/**
 * The readiness state machine behind `AvsbService`, kept apart from the
 * service so both shapes of the same three values (signal and Observable)
 * are written in exactly one place.
 *
 * The rules, in full:
 *
 * - Only a settled `InitResult` moves `status`. The client emits an `error`
 *   event before it settles a DEGRADED init successfully, so treating that
 *   event as fatal would report a working SDK as broken.
 * - A successful settle after a failed one (a later refresh rescued it) wins.
 *   `onReady()` keeps the first answer forever, so a late failure that
 *   arrives after a rescue is ignored.
 * - `degraded` never makes `status` anything other than `'ready'`. It means
 *   "serving a stale cached datafile after a failed refresh": the values are
 *   real, they may be out of date.
 */
export class AvsbStatusStore {
  private readonly _status = signal<AvsbStatus>('loading')
  private readonly _ready = signal(false)
  private readonly _degraded = signal(false)
  private readonly _error = signal<Error | null>(null)

  private readonly _status$ = new BehaviorSubject<AvsbStatus>('loading')
  private readonly _degraded$ = new BehaviorSubject<boolean>(false)
  private readonly _error$ = new BehaviorSubject<Error | null>(null)

  readonly status: Signal<AvsbStatus> = this._status.asReadonly()
  readonly ready: Signal<boolean> = this._ready.asReadonly()
  readonly degraded: Signal<boolean> = this._degraded.asReadonly()
  readonly error: Signal<Error | null> = this._error.asReadonly()

  readonly status$: Observable<AvsbStatus> = this._status$.asObservable()
  readonly degraded$: Observable<boolean> = this._degraded$.asObservable()
  readonly error$: Observable<Error | null> = this._error$.asObservable()
  readonly ready$: Observable<boolean> = this._status$.pipe(
    map((value) => value === 'ready'),
    distinctUntilChanged()
  )

  /** Flags are readable, but the init attempt has not settled yet. */
  markReadable(): void {
    this.setStatus('ready')
  }

  /** Record an error without changing readiness. */
  recordError(error: Error): void {
    this.setError(error)
  }

  /** Apply a settled init outcome. */
  applyInitResult(result: InitResult): void {
    if (!result.success && this._status() === 'ready') return

    if (result.success) {
      this.setStatus('ready')
      this.setDegraded(result.degraded === true)
      this.setError(result.degraded === true ? (result.error ?? null) : null)
      return
    }

    this.setStatus('error')
    this.setDegraded(false)
    this.setError(result.error ?? new Error(INIT_FAILED_MESSAGE))
  }

  private setStatus(next: AvsbStatus): void {
    if (this._status() === next) return
    this._status.set(next)
    this._ready.set(next === 'ready')
    this._status$.next(next)
  }

  private setDegraded(next: boolean): void {
    if (this._degraded() === next) return
    this._degraded.set(next)
    this._degraded$.next(next)
  }

  private setError(next: Error | null): void {
    if (this._error() === next) return
    this._error.set(next)
    this._error$.next(next)
  }
}
