/**
 * The slice of `AvsbClient` that `@avsbhq/react` depends on.
 *
 * This is the FROZEN store contract published by `@avsbhq/browser`
 * (see its README, "The store contract, for framework adapters").
 * `AvsbClient` satisfies it structurally, so no cast is needed anywhere;
 * the interface exists so a test or a host app can inject its own object
 * through the provider's Mode B `client` prop without depending on the
 * concrete class.
 *
 * The five methods the rendering hooks actually stand on, and the
 * guarantees they carry:
 *
 *   subscribe(flagKey, listener)  fires when that flag's value changes,
 *                                 and once on the ready transition.
 *   getSnapshot(key, default)     same object until that flag changes.
 *   get*Flag(key, def, {readOnly:true})
 *                                 same, plus the runtime type check.
 *   isReady()                     synchronous: are flags readable now?
 *   getInitResult()               synchronous: how did init settle?
 *
 * A read-only read fires NO exposure and emits NO `evaluation` event.
 * React retries, discards, and replays renders, so a render must never
 * write analytics; exposures are fired from `useExposure`, once per
 * mounted view, where a decision is actually shown to a person.
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

export interface ReactAvsbClient {
  // --- Lifecycle -------------------------------------------------------
  /** Never rejects. Resolves with how the init attempt settled. */
  onReady(options?: { timeout?: number }): Promise<InitResult>
  /** Synchronous: true once flags can be read from something real. */
  isReady(): boolean
  /** Synchronous: the settled init outcome, or null while in flight. */
  getInitResult(): InitResult | null
  close(): Promise<void>
  flush(): Promise<void>

  // --- Identity --------------------------------------------------------
  identify(context: EvalContext): void
  updateAttributes(partial: Record<string, unknown>, contextKind?: string): void
  alias(previousContext: EvalContext, newContext: EvalContext): void
  getContext(): EvalContext
  reset(): void

  // --- Reading flags ---------------------------------------------------
  getFlag<T>(flagKey: AvsbFlagKey, defaultValue: T, options?: GetFlagOptions): Flag<T>
  getBoolFlag(
    flagKey: AvsbFlagKey,
    defaultValue: boolean,
    options?: GetFlagOptions,
  ): Flag<boolean>
  getStringFlag(
    flagKey: AvsbFlagKey,
    defaultValue: string,
    options?: GetFlagOptions,
  ): Flag<string>
  getNumberFlag(
    flagKey: AvsbFlagKey,
    defaultValue: number,
    options?: GetFlagOptions,
  ): Flag<number>
  getJsonFlag<T>(flagKey: AvsbFlagKey, defaultValue: T, options?: GetFlagOptions): Flag<T>
  /**
   * Every flag, keyed by flag key. Options stay a bag on the browser
   * client on purpose (`{context, fireExposures}` disambiguates two very
   * different arguments); the server SDKs take context positionally.
   */
  getAllFlags(options?: GetAllFlagsOptions): Record<string, Flag>

  // --- Store contract --------------------------------------------------
  /** Per-flag subscription. Returns its own unsubscribe function. */
  subscribe(flagKey: AvsbFlagKey, listener: () => void): () => void
  /** Referentially stable, side-effect-free read. */
  getSnapshot<T>(flagKey: AvsbFlagKey, defaultValue: T): Flag<T>

  // --- Events ----------------------------------------------------------
  track(eventKey: string, payload?: TrackPayload): void
  /**
   * Client event bus. Returns unsubscribe.
   *
   * The legacy 3-argument `onFlagChange(flagKey, newValue, previousValue)`
   * convenience is deliberately not surfaced here: React subscribes
   * through `on('flagChange', ...)`, which carries the unified
   * `{ flagKey, previousValue, newValue }` payload.
   */
  on<E extends ClientEventName>(event: E, cb: ClientEventMap[E]): () => void

  // --- Runtime overrides (QA and local development) --------------------
  setOverrideForUser(
    flagKey: AvsbFlagKey,
    contextKey: string,
    variationKey: string,
    contextKind?: string,
  ): void
  setGlobalOverride(flagKey: AvsbFlagKey, variationKey: string): void
  clearOverrideForUser(
    flagKey: AvsbFlagKey,
    contextKey: string,
    contextKind?: string,
  ): void
  clearGlobalOverride(flagKey: AvsbFlagKey): void
  clearAllOverrides(): void
}
