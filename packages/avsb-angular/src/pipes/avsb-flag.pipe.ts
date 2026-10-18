import { Pipe } from '@angular/core'
import type { OnDestroy, PipeTransform } from '@angular/core'
import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { FlagPipeSubscription } from './flagPipeSubscription'

/**
 * Read a flag's VALUE in a template.
 *
 * ```html
 * <h1>{{ 'homepage-hero' | avsbFlag: 'Welcome' }}</h1>
 * <img [src]="'hero-image' | avsbFlag: '/img/default.png'" />
 * ```
 *
 * The value is typed from the default you pass: `'x' | avsbFlag: false` is
 * `boolean`, `'x' | avsbFlag: 0` is `number`.
 *
 * Before the datafile arrives, and for a key the datafile does not contain,
 * this returns your default. That is deliberately indistinguishable here,
 * because a template that wants a value wants a value. When you need to
 * tell those cases apart, use `avsbFlagState`, which hands back the whole
 * `Flag` including `source` and `exists()`.
 *
 * Declared impure: flag values change over time, not when the template's
 * inputs change. The pipe subscribes once per key, and calls
 * `markForCheck()` on updates so `OnPush` components re-render.
 */
@Pipe({ name: 'avsbFlag', standalone: true, pure: false })
export class AvsbFlagPipe implements PipeTransform, OnDestroy {
  private readonly _subscription = new FlagPipeSubscription()

  transform<T>(flagKey: AvsbFlagKey, defaultValue: T): T {
    const flag: Flag<T> = this._subscription.read(flagKey, defaultValue)
    return flag.value
  }

  ngOnDestroy(): void {
    this._subscription.destroy()
  }
}
