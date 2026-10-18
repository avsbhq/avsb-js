import type { Injector } from '@angular/core'
import type { AvsbClientOptions } from '@avsbhq/browser'
import type { AngularAvsbClient } from './clientInterface'

// -----------------------------------------------------------------------
// AvsbConfig: the argument to provideAvsb() and AvsbModule.forRoot().
//
// Mode A (convenience): pass `sdkKey` plus any AvsbClientOptions. The
//   package creates the client and closes it when the injector that owns
//   it is destroyed.
//
// Mode B (injection): pass a pre-built `client`. The package never closes
//   it: whoever built it owns its lifecycle. This is the testing seam and
//   the way to share one client across several Angular injectors.
// -----------------------------------------------------------------------

export type AvsbConfig =
  | (AvsbClientOptions & { client?: never })
  | { client: AngularAvsbClient }

/**
 * Readiness of the SDK, in one word.
 *
 * - `'loading'`: the first datafile load has not settled yet. Reads answer
 *   with your default value and `Flag.source === 'not_ready'`.
 * - `'ready'`: flags are answerable. Check `degraded` to learn whether the
 *   values came from a fresh datafile or a stale cached one.
 * - `'error'`: nothing could be loaded, so every read answers with your
 *   default value. `AvsbService.error` carries the reason and the fix.
 */
export type AvsbStatus = 'loading' | 'ready' | 'error'

/**
 * Passed to every standalone helper (`avsbFlag$`, `avsbFlagSignal`, ...).
 *
 * Helpers resolve `AvsbService` from the current injection context. Supply
 * an `injector` when you call one from somewhere that is not an injection
 * context (`ngOnInit`, an event handler, an RxJS callback):
 *
 * ```ts
 * private readonly injector = inject(Injector)
 *
 * ngOnInit(): void {
 *   this.hero = avsbFlagSignal('homepage-hero', 'control', {
 *     injector: this.injector,
 *   })
 * }
 * ```
 *
 * For signal helpers the injector also decides when the underlying
 * subscription is torn down: it is released when that injector is
 * destroyed.
 */
export interface AvsbInjectOptions {
  injector?: Injector
}

// -----------------------------------------------------------------------
// Re-exports from @avsbhq/browser (client options).
// -----------------------------------------------------------------------

export type {
  AvsbClientOptions,
  GetFlagOptions,
  GetAllFlagsOptions,
} from '@avsbhq/browser'

// -----------------------------------------------------------------------
// Re-exports from @avsbhq/core (evaluation and wire types).
// -----------------------------------------------------------------------

export type {
  Flag,
  EvalContext,
  SingleContext,
  MultiContext,
  TrackPayload,
  InitResult,
  ClientEventMap,
  ClientEventName,
  EvaluationSource,
  RuleType,
  FlagDatafile,
  FlagDatafileEntry,
  FlagDatafileVariation,
  FlagDatafileOverride,
  FlagDatafileRule,
  FlagDatafileAudience,
  Logger,
} from '@avsbhq/core'

// `DecideOption` is a const object AND a type, so it is re-exported as a
// value (from `public-api.ts`). A type-only re-export would compile but
// leave `DecideOption.DISABLE_EXPOSURE` unreachable at runtime, which is
// the defect report 03 section 2 recorded against this family.
