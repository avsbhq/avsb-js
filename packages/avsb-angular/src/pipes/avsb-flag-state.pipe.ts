import { Pipe } from '@angular/core'
import type { OnDestroy, PipeTransform } from '@angular/core'
import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { FlagPipeSubscription } from './flagPipeSubscription'

/**
 * Read the whole `Flag` in a template, not just its value.
 *
 * Use it when the template has to tell "the SDK has no datafile yet" and
 * "that key is not in the datafile" apart from a real `false`:
 *
 * ```html
 * @let state = 'checkout-v2' | avsbFlagState: false;
 *
 * @if (state.source === 'not_ready') {
 *   <app-skeleton />
 * } @else if (state.isEnabled()) {
 *   <app-new-checkout />
 * } @else {
 *   <app-legacy-checkout />
 * }
 * ```
 *
 * `Flag.source` is the full answer: `'not_ready'` before the first
 * datafile, `'not_found'` for a key the datafile does not carry,
 * `'default'` / `'disabled'` for a flag that exists but did not match, and
 * `'rule'` / `'holdout'` / `'bandit'` / `'sticky'` / `'runtimeOverride'` /
 * `'datafileOverride'` for a real decision.
 *
 * Like `avsbFlag`, this is impure and fires no exposure.
 */
@Pipe({ name: 'avsbFlagState', standalone: true, pure: false })
export class AvsbFlagStatePipe implements PipeTransform, OnDestroy {
  private readonly _subscription = new FlagPipeSubscription()

  transform<T>(flagKey: AvsbFlagKey, defaultValue: T): Flag<T> {
    return this._subscription.read(flagKey, defaultValue)
  }

  ngOnDestroy(): void {
    this._subscription.destroy()
  }
}
