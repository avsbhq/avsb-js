/**
 * The surface of `AvsbClient` that `@avsbhq/angular` depends on.
 *
 * It mirrors the store contract frozen in `@avsbhq/browser`'s README
 * (section 8, "The store contract, for framework adapters") plus the
 * lifecycle, identity and tracking methods this package forwards.
 * `AvsbClient` satisfies it structurally, so `provideAvsb({ sdkKey })`
 * assigns a real client to this type with no cast.
 *
 * It is also the type of anything passed to `provideAvsb({ client })`,
 * which is how tests inject a stand-in.
 */
import type {
  Flag,
  EvalContext,
  TrackPayload,
  InitResult,
  ClientEventMap,
  ClientEventName,
  AvsbFlagKey,
} from '@avsbhq/core'
import type { GetFlagOptions, GetAllFlagsOptions } from '@avsbhq/browser'

export interface AngularAvsbClient {
  // -- Lifecycle -----------------------------------------------------------

  /** Resolves when the init attempt settles. Never rejects. */
  onReady(options?: { timeout?: number }): Promise<InitResult>
  /** Synchronous: can flags be read right now? */
  isReady(): boolean
  /** The settled init outcome, or null while the first attempt is in flight. */
  getInitResult(): InitResult | null
  close(): Promise<void>
  flush(): Promise<void>

  // -- Identity ------------------------------------------------------------

  identify(context: EvalContext): void
  updateAttributes(partial: Record<string, unknown>, contextKind?: string): void
  /**
   * Synchronous: it records one `avsb_alias` event and returns. The browser
   * README's type block still shows `Promise<void>` here, which
   * `AvsbClient.ts` has not matched since the alias rewrite (verified against
   * source: `alias(previousContext, newContext): void`). This interface
   * follows the source, because that is what has to compile.
   */
  alias(previousContext: EvalContext, newContext: EvalContext): void
  getContext(): EvalContext
  reset(): void

  // -- Reading flags -------------------------------------------------------

  getFlag<T>(flagKey: AvsbFlagKey, defaultValue: T, options?: GetFlagOptions): Flag<T>
  getBoolFlag(
    flagKey: AvsbFlagKey,
    defaultValue: boolean,
    options?: GetFlagOptions
  ): Flag<boolean>
  getStringFlag(
    flagKey: AvsbFlagKey,
    defaultValue: string,
    options?: GetFlagOptions
  ): Flag<string>
  getNumberFlag(
    flagKey: AvsbFlagKey,
    defaultValue: number,
    options?: GetFlagOptions
  ): Flag<number>
  getJsonFlag<T>(
    flagKey: AvsbFlagKey,
    defaultValue: T,
    options?: GetFlagOptions
  ): Flag<T>
  getAllFlags(options?: GetAllFlagsOptions): Record<string, Flag>

  // -- Store contract ------------------------------------------------------

  /**
   * Notified when this flag's value changes, and once when the first
   * datafile is applied. Returns its own unsubscribe function.
   */
  subscribe(flagKey: AvsbFlagKey, listener: () => void): () => void
  /**
   * The same object on every call until this flag's value changes. Fires no
   * exposure and emits no `evaluation` event.
   */
  getSnapshot<T>(flagKey: AvsbFlagKey, defaultValue: T): Flag<T>

  // -- Tracking ------------------------------------------------------------

  track(eventKey: string, payload?: TrackPayload): void
  on<E extends ClientEventName>(event: E, cb: ClientEventMap[E]): () => void

  // -- Runtime overrides (QA and local development) ------------------------

  setOverrideForUser(
    flagKey: AvsbFlagKey,
    contextKey: string,
    variationKey: string,
    contextKind?: string
  ): void
  setGlobalOverride(flagKey: AvsbFlagKey, variationKey: string): void
  clearOverrideForUser(
    flagKey: AvsbFlagKey,
    contextKey: string,
    contextKind?: string
  ): void
  clearGlobalOverride(flagKey: AvsbFlagKey): void
  clearAllOverrides(): void
}
