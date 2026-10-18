import type { Signal } from '@angular/core'
import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { resolveService } from './internal/injectionContext'
import type { AvsbInjectOptions, AvsbStatus } from './types'

// ---------------------------------------------------------------------------
// Signal helpers.
//
// Injection context matters more here than for the Observable helpers,
// because the injector also decides WHEN the underlying subscription is
// released: it is torn down when that injector is destroyed.
//
// Safe with no options:
//   - a component or directive field initializer
//   - a constructor
//   - a factory (`useFactory`, `inject()` call sites)
//   - inside `runInInjectionContext(injector, ...)`
//
// Needs `{ injector }`:
//   - `ngOnInit` and every other lifecycle hook
//   - event handlers, `setTimeout`, RxJS callbacks, promise continuations
//
// Called outside an injection context with no `injector`, they throw
// Angular's NG0203 naming the helper you called.
// ---------------------------------------------------------------------------

/**
 * One flag as a signal.
 *
 * ```ts
 * export class HeroComponent {
 *   readonly hero: Signal<Flag<string>> = avsbFlagSignal('homepage-hero', 'control')
 * }
 * ```
 * ```html
 * @if (hero().value === 'variant-a') { <app-hero-a /> }
 * ```
 *
 * The signal always holds a `Flag`, never `undefined`: the first value is
 * read synchronously when the signal is created.
 */
export function avsbFlagSignal<T>(
  flagKey: AvsbFlagKey,
  defaultValue: T,
  options?: AvsbInjectOptions
): Signal<Flag<T>> {
  return resolveService(avsbFlagSignal, options).flagSignal<T>(
    flagKey,
    defaultValue,
    options
  )
}

/** Just the value of one flag, as a signal. */
export function avsbFlagValueSignal<T>(
  flagKey: AvsbFlagKey,
  defaultValue: T,
  options?: AvsbInjectOptions
): Signal<T> {
  return resolveService(avsbFlagValueSignal, options).flagValueSignal<T>(
    flagKey,
    defaultValue,
    options
  )
}

/** One boolean flag as a signal. A non-boolean value falls back. */
export function avsbBoolFlagSignal(
  flagKey: AvsbFlagKey,
  defaultValue: boolean,
  options?: AvsbInjectOptions
): Signal<Flag<boolean>> {
  return resolveService(avsbBoolFlagSignal, options).boolFlagSignal(
    flagKey,
    defaultValue,
    options
  )
}

/** One string flag as a signal. A non-string value falls back. */
export function avsbStringFlagSignal(
  flagKey: AvsbFlagKey,
  defaultValue: string,
  options?: AvsbInjectOptions
): Signal<Flag<string>> {
  return resolveService(avsbStringFlagSignal, options).stringFlagSignal(
    flagKey,
    defaultValue,
    options
  )
}

/** One number flag as a signal. A non-number value falls back. */
export function avsbNumberFlagSignal(
  flagKey: AvsbFlagKey,
  defaultValue: number,
  options?: AvsbInjectOptions
): Signal<Flag<number>> {
  return resolveService(avsbNumberFlagSignal, options).numberFlagSignal(
    flagKey,
    defaultValue,
    options
  )
}

/** One JSON flag as a signal. `T` is your assertion, not a runtime check. */
export function avsbJsonFlagSignal<T>(
  flagKey: AvsbFlagKey,
  defaultValue: T,
  options?: AvsbInjectOptions
): Signal<Flag<T>> {
  return resolveService(avsbJsonFlagSignal, options).jsonFlagSignal<T>(
    flagKey,
    defaultValue,
    options
  )
}

/** Every flag in the datafile, as a signal. */
export function avsbAllFlagsSignal(
  options?: AvsbInjectOptions
): Signal<Record<string, Flag>> {
  return resolveService(avsbAllFlagsSignal, options).allFlagsSignal(options)
}

/**
 * `'loading' | 'ready' | 'error'` as a signal.
 *
 * This one is on the service already, so it needs no injection context of
 * its own: `inject(AvsbService).status` is the same signal.
 */
export function avsbStatusSignal(
  options?: AvsbInjectOptions
): Signal<AvsbStatus> {
  return resolveService(avsbStatusSignal, options).status
}

/** `true` once the SDK can answer with real values, as a signal. */
export function avsbReadySignal(options?: AvsbInjectOptions): Signal<boolean> {
  return resolveService(avsbReadySignal, options).ready
}

/** The last SDK error, or null, as a signal. */
export function avsbErrorSignal(
  options?: AvsbInjectOptions
): Signal<Error | null> {
  return resolveService(avsbErrorSignal, options).error
}

/** `true` while the SDK serves stale values after a failed refresh. */
export function avsbDegradedSignal(
  options?: AvsbInjectOptions
): Signal<boolean> {
  return resolveService(avsbDegradedSignal, options).degraded
}
