/**
 * The slice of `AvsbClient` (@avsbhq/browser) that @avsbhq/vue depends on.
 *
 * This is the store contract documented in the browser SDK's README under
 * "The store contract, for framework adapters": `subscribe` + `getSnapshot`
 * for render-safe reads, the typed getters with `{ readOnly: true }` for
 * render paths, and `isReady()` / `getInitResult()` for a synchronous first
 * pass. A real `AvsbClient` satisfies this interface structurally, so no cast
 * is required at the boundary.
 *
 * Why an interface at all: composables take the client from the provider's
 * injected context, so a test (or a Storybook decorator) can inject anything
 * that speaks this surface. `@avsbhq/vue/testing` ships one that is a real
 * `AvsbClient` with the network switched off.
 */
import type {
  Flag,
  FlagDatafile,
  EvalContext,
  TrackPayload,
  InitResult,
  ClientEventMap,
  ClientEventName,
  AvsbFlagKey,
} from '@avsbhq/core'
import type { GetFlagOptions, GetAllFlagsOptions } from '@avsbhq/browser'

export interface VueAvsbClient {
  // --- Lifecycle -----------------------------------------------------------
  /** Resolves when the init attempt settles. Never rejects. */
  onReady(options?: { timeout?: number }): Promise<InitResult>
  /** True when flags are readable right now (bootstrap, cache, or network). */
  isReady(): boolean
  /** The settled init outcome, or null while the first attempt is in flight. */
  getInitResult(): InitResult | null
  /** Adopt a datafile received out of band (SSR bootstrap). */
  applyDatafileBootstrap(datafile: FlagDatafile): void
  refresh(): Promise<void>
  flush(): Promise<void>
  close(): Promise<void>

  // --- Identity ------------------------------------------------------------
  identify(context: EvalContext): void
  updateAttributes(partial: Record<string, unknown>, contextKind?: string): void
  /**
   * Queues one `avsb_alias` event and returns. Synchronous: there is nothing
   * to await, and it does not rewrite assignments already made.
   */
  alias(previousContext: EvalContext, newContext: EvalContext): void
  getContext(): EvalContext
  /** New anonymous identity, overrides cleared. Call on sign-out. */
  reset(): void

  // --- Reading flags -------------------------------------------------------
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

  // --- Store contract ------------------------------------------------------
  /**
   * Called when this flag's value changes, and once when the first datafile
   * is applied. Returns its own unsubscribe function.
   */
  subscribe(flagKey: AvsbFlagKey, listener: () => void): () => void
  /**
   * Render-safe read: the SAME frozen object until the value changes, no
   * exposure, no `evaluation` event.
   */
  getSnapshot<T>(flagKey: AvsbFlagKey, defaultValue: T): Flag<T>

  // --- Events --------------------------------------------------------------
  track(eventKey: string, payload?: TrackPayload): void
  on<E extends ClientEventName>(event: E, cb: ClientEventMap[E]): () => void

  // --- Runtime overrides (QA and local development) ------------------------
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
