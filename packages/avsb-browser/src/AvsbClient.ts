import type { AvsbClientOptions, GetFlagOptions, GetAllFlagsOptions } from './types'
import type { EvalContext, Flag, InitResult, TrackPayload, FlagDatafile } from '@avsbhq/core'
import type { ClientEventMap, ClientEventName, AvsbFlagKey } from '@avsbhq/core'
import type { AvsbUtils, FlagSnapshot } from '@avsbhq/utils'
import { primaryKeyOf } from './identity'
import { createClientState, warnOnce } from './clientState'
import type { ClientState } from './clientState'
import {
  applyDatafileBootstrap,
  applySnapshot,
  closeClient,
  initialize,
  pollOnce,
  waitForReady,
} from './clientDatafile'
import { readAllFlags, readFlag, readTyped } from './clientEvaluation'
import { buildClientUtils, diffAndEmitChanges, subscribeToFlag } from './clientEvents'
import { mergeAttributes, resetIdentity, serveInitialDatafile } from './clientPersistence'
import { trackEvent } from './clientTracking'

// The class is the public surface. Its state lives in one object
// (./clientState) and the work is done in ./clientDatafile,
// ./clientEvaluation, ./clientTracking, ./clientEvents and
// ./clientPersistence (FU-31).

type FlagChangeCallback = (flagKey: string, newValue: unknown, oldValue: unknown) => void

// ---------------------------------------------------------------------------
// AvsbClient
//
// Lifecycle contract, which the seven framework adapters build on:
//
//   new AvsbClient({ sdkKey })
//     validates the key shape, resolves a PERSISTED visitor id, serves any
//     cached datafile immediately, and starts the network load. Nothing
//     needs to be called to begin.
//   isReady()
//     true the moment flags are readable (bootstrap, cache, or network).
//   onReady({ timeout })
//     resolves once the init attempt settles, and NEVER rejects.
//       success: true,  source: 'bootstrap' | 'network'
//       success: true,  degraded: true      serving cache after a failed refresh
//       success: false, source: 'error' | 'timeout'   nothing to serve (B1)
//   getSnapshot(key, default) / get*Flag(key, default, { readOnly: true })
//     referentially stable, side-effect-free reads for render paths.
// ---------------------------------------------------------------------------

export class AvsbClient {
  /** Everything mutable about this client. See ./clientState. */
  private readonly s: ClientState

  // ---- §6 client.utils.* surface, built lazily on first access ----
  private _utils: AvsbUtils | null = null
  get utils(): AvsbUtils {
    if (!this._utils) this._utils = buildClientUtils(this, this.s)
    return this._utils
  }

  constructor(options: AvsbClientOptions) {
    this.s = createClientState(options)
    serveInitialDatafile(this.s, options)

    // Auto-start (report 02 §5.4, §7.9): a missed `await onReady()` used to
    // mean "flags never work". Now construction begins the load.
    if (options.autoInit !== false) {
      void initialize(this.s)
    }
  }

  // ---- §5.4 onReady(): Promise<InitResult> — never rejects ----

  /**
   * Await the init attempt. Never rejects.
   *
   * `timeout` bounds how long YOU wait, not the SDK: init continues in the
   * background, so a client that times out at 500ms can still become ready
   * a second later. What the timeout resolves with depends on whether
   * anything is readable meanwhile:
   *   bootstrap or cache present → { success: true, degraded: true, source: 'timeout' }
   *   nothing present            → { success: false, source: 'timeout', error }
   *
   * Calling it is also what STARTS init on an `autoInit: false` client, so a
   * caller who deferred the load can begin it by awaiting readiness. That
   * lazy start is skipped once init has ALREADY SETTLED, which is the state
   * `applyDatafileBootstrap` and `applySnapshot` leave the client in.
   *
   * Why the guard is not cosmetic: `settleInit` keeps the first successful
   * result, so a fetch started here could never change the answer, and the
   * client it belongs to is one that was explicitly told not to reach the
   * network. That combination is exactly `createTestClient` in @avsbhq/test:
   * it builds an `autoInit: false` client, hands the datafile straight in,
   * and every framework provider then awaits readiness, so without this a
   * whole test suite would dial the production CDN once per client. The SSR
   * handoff (`applySnapshot` on a deferred client) is the same shape.
   *
   * A caller who DOES want a network load after a bootstrap calls
   * `refresh()`, which is the explicit door and was always the honest one.
   */
  onReady(options?: { timeout?: number }): Promise<InitResult> {
    return waitForReady(this.s, options)
  }

  /**
   * True once flags are readable: a bootstrap or cached datafile is in
   * memory, or the network load finished. Synchronous, so a framework
   * adapter can decide what to render on the very first pass.
   */
  isReady(): boolean {
    // "Flags are readable right now", which an adopted server snapshot also
    // satisfies even before a datafile has loaded.
    return this.s.ready || this.s.snapshotBootstrap.isActive()
  }

  /**
   * The settled init outcome, or null while the first attempt is still in
   * flight. Lets an adapter surface `status: 'error'` with the real message
   * without holding its own copy of the promise.
   */
  getInitResult(): InitResult | null {
    return this.s.initResult
  }

  // ---- §5.2 Identity methods ----

  /** Replace the entire bound context. Rehashes bucketing immediately. */
  identify(context: EvalContext): void {
    this.s.context = context
    diffAndEmitChanges(this.s)
  }

  /**
   * Merge attributes into the current context.
   * `contextKind` defaults to 'user'.
   */
  updateAttributes(partial: Record<string, unknown>, contextKind: string = 'user'): void {
    mergeAttributes(this.s, partial, contextKind)
  }

  /**
   * Mark the moment a signup or login claimed an anonymous session.
   *
   * SYNCHRONOUS (report 02 §5.32). It used to be declared `async`, which
   * implied awaiting mattered when the promise resolved immediately after a
   * synchronous `track`, and every port copied the asymmetry with `identify`.
   *
   * WHAT IT DOES: queues one `avsb_alias` event attributed to the NEW
   * identity's key, so the moment shows up in the event stream.
   *
   * WHAT IT DOES NOT DO, precisely:
   *   - It does not rewrite sticky assignments or move past exposures. Nothing
   *     already decided for either identity changes.
   *   - It does not store the PREVIOUS key. The conversion wire
   *     (`/v1/collect/metric-batch`) carries no properties column, so a
   *     retroactive session join is not available yet.
   *
   * To carry bucketing across a login, evaluate with the SAME context key on
   * both sides: keep using the anonymous visitor id after sign-in, or set the
   * account id before the first evaluation.
   */
  alias(previousContext: EvalContext, newContext: EvalContext): void {
    const previousKey = primaryKeyOf(previousContext)
    const newKey = primaryKeyOf(newContext)
    const boundKey = primaryKeyOf(this.s.context)

    if (newKey && boundKey !== newKey) {
      // The event is attributed to whatever this client is bound to, so an
      // alias called before `identify` lands on the OLD identity.
      warnOnce(
        this.s,
        'alias-before-identify',
        `alias() records its event against the identity this client is bound to ` +
          `("${boundKey}"), not the one passed as the new context ("${newKey}"). ` +
          'Call identify(newContext) first, then alias(previousContext, newContext).',
      )
    }
    this.s.logger.debug(`alias: ${previousKey} to ${newKey}`)

    this.track('avsb_alias')
  }

  /** §5.2 read-only snapshot of current context. */
  getContext(): EvalContext {
    return this.s.context
  }

  /**
   * §5.2 reset: return to a NEW anonymous identity and clear overrides.
   *
   * The persisted visitor id is rotated, not reused: after a logout the
   * next anonymous session has to be a different visitor, or the previous
   * user's bucketing (and their exposures) would follow the next one.
   */
  reset(): void {
    resetIdentity(this.s)
  }

  // ---- §5.13 + §5.11 — unified Flag<T> evaluation ----

  /**
   * Generic getFlag. Returns `Flag<T>`, never the raw value.
   *
   * `T` comes from the explicit type argument when you give one
   * (`getFlag<string | null>('k', null)`) and from the default value when you
   * do not (`getFlag('k', false)` is `Flag<boolean>`). The signature used to
   * read `NoInfer<T> | T`, which is inert: the naked `T` in the union
   * re-enables the very inference `NoInfer` was there to block, so it only
   * made a public signature that adapters copy harder to read.
   */
  getFlag<T>(flagKey: AvsbFlagKey, defaultValue: T, options?: GetFlagOptions): Flag<T> {
    return readFlag<T>(this.s, flagKey, defaultValue, 'any', options)
  }

  /** §5.11: typed boolean variant. */
  getBoolFlag(
    flagKey: AvsbFlagKey,
    defaultValue: boolean,
    options?: GetFlagOptions
  ): Flag<boolean> {
    return readTyped(this.s, flagKey, defaultValue, 'boolean', options)
  }

  /** §5.11: typed string variant. */
  getStringFlag(
    flagKey: AvsbFlagKey,
    defaultValue: string,
    options?: GetFlagOptions
  ): Flag<string> {
    return readTyped(this.s, flagKey, defaultValue, 'string', options)
  }

  /** §5.11: typed number variant. */
  getNumberFlag(
    flagKey: AvsbFlagKey,
    defaultValue: number,
    options?: GetFlagOptions
  ): Flag<number> {
    return readTyped(this.s, flagKey, defaultValue, 'number', options)
  }

  /** §5.11: typed JSON variant. */
  getJsonFlag<T>(flagKey: AvsbFlagKey, defaultValue: T, options?: GetFlagOptions): Flag<T> {
    return readTyped<T>(this.s, flagKey, defaultValue, 'json', options)
  }

  // ---- §5.6 Unified track ----

  track(eventKey: string, payload?: TrackPayload): void {
    trackEvent(this.s, eventKey, payload)
  }

  // ---- §5.7 getAllFlags — returns Record<string, Flag> with exposures suppressed ----

  getAllFlags(options?: GetAllFlagsOptions): Record<string, Flag> {
    return readAllFlags(this.s, options)
  }

  // ---- §5.9 Override methods ----

  setOverrideForUser(
    flagKey: string,
    contextKey: string,
    variationKey: string,
    contextKind: string = 'user'
  ): void {
    this.s.overrides.setForContext(flagKey, contextKey, variationKey, contextKind)
    diffAndEmitChanges(this.s)
  }

  setGlobalOverride(flagKey: string, variationKey: string): void {
    this.s.overrides.setGlobal(flagKey, variationKey)
    diffAndEmitChanges(this.s)
  }

  clearOverrideForUser(flagKey: string, contextKey: string, contextKind: string = 'user'): void {
    this.s.overrides.clearForContext(flagKey, contextKey, contextKind)
    diffAndEmitChanges(this.s)
  }

  clearGlobalOverride(flagKey: string): void {
    this.s.overrides.clearGlobal(flagKey)
    diffAndEmitChanges(this.s)
  }

  clearAllOverrides(): void {
    this.s.overrides.clearAll()
    diffAndEmitChanges(this.s)
  }

  // ---- §5.14-adjacent: subscribe + getSnapshot for useSyncExternalStore ----

  /**
   * Subscribe to value changes for a specific flag. Returns an unsubscribe fn.
   *
   * Fires when that flag's value changes (datafile update, identify,
   * override) and on the ready transition, so a component mounted before
   * the datafile arrives re-reads once it does.
   */
  subscribe(flagKey: string, listener: () => void): () => void {
    return subscribeToFlag(this.s, flagKey, listener)
  }

  /**
   * Synchronous snapshot for `useSyncExternalStore`.
   *
   * Returns the SAME frozen object on every call until that flag's value
   * changes, which is the contract React requires: it compares snapshots by
   * identity, and a fresh object per call is the "getSnapshot should be
   * cached to avoid an infinite loop" error. Fires no exposure and emits no
   * `evaluation` event, because a render is a read, not a decision.
   */
  getSnapshot<T>(flagKey: AvsbFlagKey, defaultValue: T): Flag<T> {
    return readFlag<T>(this.s, flagKey, defaultValue, 'any', { readOnly: true })
  }

  // ---- Event bus (§5.14-adjacent) ----

  /** Subscribe to any client event. Returns unsubscribe. */
  on<E extends ClientEventName>(
    event: E,
    cb: ClientEventMap[E]
  ): () => void {
    return this.s.bus.on(event, cb)
  }

  /**
   * Convenience: listen to flag-change events.
   * Wraps the event bus in the legacy 3-arg callback shape.
   */
  onFlagChange(callback: FlagChangeCallback): () => void {
    return this.s.bus.on('flagChange', (data) => {
      callback(data.flagKey, data.newValue, data.previousValue)
    })
  }

  // ---- Bootstrap handoff + manual refresh ----

  /**
   * Apply a datafile received out of band, e.g. from an SSR bootstrap blob
   * via `client.utils.hydrateBootstrap`. Marks the client ready and wakes
   * every subscriber, exactly like a network arrival.
   *
   * It does NOT stop the normal lifecycle: if the client was constructed with
   * `autoInit` on, the background load and the polling loop continue, so a
   * blob that was already stale when the page rendered is replaced by the live
   * datafile on the next tick.
   */
  applyDatafileBootstrap(datafile: FlagDatafile): void {
    applyDatafileBootstrap(this.s, datafile)
  }

  /**
   * Adopt SERVER-EVALUATED flag values for this context until a real datafile
   * is readable (report 02 §5.6, the other half of the SSR handoff).
   *
   * This is what makes `client.utils.hydrateBootstrap(blob)` do something on a
   * blob serialised without `includeDatafile`: the first render reads the same
   * values the server rendered, with no flicker and no fetch on the critical
   * path. The moment a datafile arrives (network, cache, or
   * `applyDatafileBootstrap`) the snapshot is released and local evaluation
   * takes over.
   *
   * Provenance stays honest: each flag keeps the `source` the server recorded
   * and gains one reason naming the snapshot and its capture time. Reads from
   * it fire NO exposures, because the server already decided whether to record
   * one; double-counting a decision would corrupt results.
   */
  applySnapshot(snap: FlagSnapshot): void {
    applySnapshot(this.s, snap)
  }

  /**
   * Fetch the datafile now and apply it if it changed.
   *
   * Note for reviewers: the previous `client.utils.refresh` binding fetched
   * and then threw the result away, so `snapshotFresh()` refreshed nothing.
   */
  async refresh(): Promise<void> {
    await pollOnce(this.s, 'manual')
  }

  // ---- §5.20 flush + close ----

  async flush(): Promise<void> {
    if (!this.s.tracker) return
    await this.s.tracker.flush()
  }

  close(): Promise<void> {
    return closeClient(this.s, () => this._utils?._drain())
  }

  // Deleted in breaking change B5, on purpose: setAttributes(attrs) is now
  // updateAttributes(partial, kind?), and getFlagDetails(key) is getFlag(key,
  // default), which returns Flag<T>. Both were `@deprecated` shims in a
  // pre-launch 1.x; the README migration table carries the same two lines.
}
