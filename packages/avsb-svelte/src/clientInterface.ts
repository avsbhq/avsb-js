/**
 * The slice of `AvsbClient` (@avsbhq/browser) that @avsbhq/svelte depends on.
 *
 * This is the store contract documented in the browser SDK's README under
 * "The store contract, for framework adapters": `subscribe` + `getSnapshot`
 * for render-safe reads, the typed getters with `{ readOnly: true }` for
 * anything a component renders, and `isReady()` / `getInitResult()` for a
 * synchronous first pass. A real `AvsbClient` satisfies this structurally,
 * so nothing has to be cast at the boundary.
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

export interface SvelteAvsbClient {
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
  /** Queues one `avsb_alias` event and returns. Nothing to await. */
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
  subscribe(flagKey: AvsbFlagKey, listener: () => void): () => void
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
