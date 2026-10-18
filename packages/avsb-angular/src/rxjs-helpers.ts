import { Observable } from 'rxjs'
import type { AvsbFlagKey, Flag, EvalContext, TrackPayload } from '@avsbhq/core'
import { resolveService } from './internal/injectionContext'
import type { AvsbInjectOptions, AvsbStatus } from './types'

// ---------------------------------------------------------------------------
// Observable helpers.
//
// Each one resolves `AvsbService` for you. Called with no `options`, they
// must run in an injection context: a field initializer, a constructor, a
// factory, or inside `runInInjectionContext`. Pass `{ injector }` to call
// them from anywhere else (`ngOnInit`, an event handler, an RxJS callback).
//
// Every name carries the `avsb` prefix so nothing here can collide with a
// `track` or `identify` of your own.
// ---------------------------------------------------------------------------

/** One flag, with its metadata. Emits immediately, then on every change. */
export function avsbFlag$<T>(
  flagKey: AvsbFlagKey,
  defaultValue: T,
  options?: AvsbInjectOptions
): Observable<Flag<T>> {
  return resolveService(avsbFlag$, options).getFlag<T>(flagKey, defaultValue)
}

/** Just the value of one flag. */
export function avsbFlagValue$<T>(
  flagKey: AvsbFlagKey,
  defaultValue: T,
  options?: AvsbInjectOptions
): Observable<T> {
  return resolveService(avsbFlagValue$, options).getFlagValue<T>(
    flagKey,
    defaultValue
  )
}

/** One boolean flag. A non-boolean value falls back to `defaultValue`. */
export function avsbBoolFlag$(
  flagKey: AvsbFlagKey,
  defaultValue: boolean,
  options?: AvsbInjectOptions
): Observable<Flag<boolean>> {
  return resolveService(avsbBoolFlag$, options).getBoolFlag(flagKey, defaultValue)
}

/** One string flag. A non-string value falls back to `defaultValue`. */
export function avsbStringFlag$(
  flagKey: AvsbFlagKey,
  defaultValue: string,
  options?: AvsbInjectOptions
): Observable<Flag<string>> {
  return resolveService(avsbStringFlag$, options).getStringFlag(
    flagKey,
    defaultValue
  )
}

/** One number flag. A non-number value falls back to `defaultValue`. */
export function avsbNumberFlag$(
  flagKey: AvsbFlagKey,
  defaultValue: number,
  options?: AvsbInjectOptions
): Observable<Flag<number>> {
  return resolveService(avsbNumberFlag$, options).getNumberFlag(
    flagKey,
    defaultValue
  )
}

/** One JSON flag. `T` is your assertion about the payload, not a check. */
export function avsbJsonFlag$<T>(
  flagKey: AvsbFlagKey,
  defaultValue: T,
  options?: AvsbInjectOptions
): Observable<Flag<T>> {
  return resolveService(avsbJsonFlag$, options).getJsonFlag<T>(
    flagKey,
    defaultValue
  )
}

/** Every flag in the datafile, keyed by flag key. */
export function avsbAllFlags$(
  options?: AvsbInjectOptions
): Observable<Record<string, Flag>> {
  return resolveService(avsbAllFlags$, options).getAllFlags()
}

/** `'loading' | 'ready' | 'error'`. */
export function avsbStatus$(
  options?: AvsbInjectOptions
): Observable<AvsbStatus> {
  return resolveService(avsbStatus$, options).status$
}

/** `true` once the SDK can answer with real values. */
export function avsbReady$(options?: AvsbInjectOptions): Observable<boolean> {
  return resolveService(avsbReady$, options).ready$
}

/**
 * The last SDK error, or null. Non-null with `status === 'error'` (fatal)
 * and while `degraded` is true (stale values, still usable).
 */
export function avsbError$(
  options?: AvsbInjectOptions
): Observable<Error | null> {
  return resolveService(avsbError$, options).error$
}

/** `true` while the SDK serves stale values after a failed refresh. */
export function avsbDegraded$(
  options?: AvsbInjectOptions
): Observable<boolean> {
  return resolveService(avsbDegraded$, options).degraded$
}

// ---------------------------------------------------------------------------
// Action helpers.
// ---------------------------------------------------------------------------

/** Record a conversion event. */
export function avsbTrack(
  eventKey: string,
  payload?: TrackPayload,
  options?: AvsbInjectOptions
): void {
  resolveService(avsbTrack, options).track(eventKey, payload)
}

/** Replace the evaluation context. Every flag re-evaluates immediately. */
export function avsbIdentify(
  context: EvalContext,
  options?: AvsbInjectOptions
): void {
  resolveService(avsbIdentify, options).identify(context)
}

/**
 * Link an anonymous context to an identified one. Call once, at sign-in,
 * after `avsbIdentify(newContext)`.
 */
export function avsbAlias(
  previousContext: EvalContext,
  newContext: EvalContext,
  options?: AvsbInjectOptions
): void {
  resolveService(avsbAlias, options).alias(previousContext, newContext)
}

/** Drop the current identity and start a fresh anonymous one. */
export function avsbReset(options?: AvsbInjectOptions): void {
  resolveService(avsbReset, options).reset()
}

/**
 * Record that this visitor was shown the decision for `flagKey`. Returns a
 * cancel function for the case where the SDK was not ready yet.
 */
export function avsbRecordExposure(
  flagKey: AvsbFlagKey,
  defaultValue: unknown = null,
  options?: AvsbInjectOptions
): () => void {
  return resolveService(avsbRecordExposure, options).recordExposure(
    flagKey,
    defaultValue
  )
}
