import { ChangeDetectorRef, inject } from '@angular/core'
import type { Subscription } from 'rxjs'
import type { Flag } from '@avsbhq/core'
import { AvsbService } from '../avsb.service'

/**
 * The subscription bookkeeping both flag pipes share.
 *
 * The important property is that there is no "no value yet" state. The
 * service's flag stream emits synchronously on subscribe, so `read()` has a
 * real `Flag` before it returns on the very first call. The old pipe treated
 * `undefined` as "nothing has arrived", which made a legitimately undefined
 * value and a pre-ready read look identical; there is nothing left to
 * conflate here, and `flag.source` tells the two apart (`not_ready` before
 * the datafile, `not_found` for a key it does not contain).
 *
 * Constructed inside a pipe, so `inject()` runs in that pipe's injection
 * context.
 */
export class FlagPipeSubscription {
  private readonly _service = inject(AvsbService)
  private readonly _changeDetector = inject(ChangeDetectorRef)

  private _subscription: Subscription | null = null
  private _flagKey: string | null = null
  private _defaultValue: unknown = undefined
  private _latest: Flag<unknown> | null = null

  /**
   * The current `Flag` for this key, subscribing (or re-subscribing) when
   * the key or the default value changes.
   */
  read<T>(flagKey: string, defaultValue: T): Flag<T> {
    if (
      this._subscription === null ||
      flagKey !== this._flagKey ||
      !Object.is(defaultValue, this._defaultValue)
    ) {
      this._subscribe(flagKey, defaultValue)
    }
    // `_subscribe` always leaves `_latest` set: the stream emits
    // synchronously. The fallback keeps the types honest without a
    // non-null assertion.
    return (this._latest ?? this._service.snapshot(flagKey, defaultValue)) as Flag<T>
  }

  destroy(): void {
    this._subscription?.unsubscribe()
    this._subscription = null
  }

  private _subscribe<T>(flagKey: string, defaultValue: T): void {
    this._subscription?.unsubscribe()
    this._flagKey = flagKey
    this._defaultValue = defaultValue
    this._latest = null

    let synchronous = true
    this._subscription = this._service
      .getFlag(flagKey, defaultValue)
      .subscribe((flag: Flag<unknown>) => {
        this._latest = flag
        // The first emission arrives inside this call, before the pipe has
        // returned anything: marking then would be a change detection call
        // during change detection.
        if (!synchronous) this._changeDetector.markForCheck()
      })
    synchronous = false
  }
}
