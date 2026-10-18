// =====================================================================
// The public shape of `createMockClient`.
//
// Kept next to the factory rather than inside it so the surface can be read
// in one screen and diffed against `AngularAvsbClient` (@avsbhq/angular) and
// `AvsbClient` (@avsbhq/browser), which is the check that matters: the
// framework adapters type their injection seams against the real client, so
// a mock missing one method is a runtime TypeError, not a weaker mock.
// =====================================================================

import type {
  Flag,
  EvalContext,
  FlagDatafile,
  TrackPayload,
  ClientEventMap,
  ClientEventName,
  InitResult,
} from '@avsbhq/core';
import type { GetFlagOptions, GetAllFlagsOptions } from '@avsbhq/browser';
import type { AvsbUtils, FlagSnapshot } from '@avsbhq/utils';
import type { EvaluationRecord } from './mockEvaluator';

export interface MockClientOptions {
  /**
   * Map of flagKey to value (boolean, string, number, or object). Reads
   * return a rule-served `Flag<T>` carrying these.
   */
  flags?: Record<string, unknown>;
  /**
   * Per-context override map: `{ [`${flagKey}:${contextKey}`]: value }`.
   * Higher precedence than `flags`.
   */
  flagsByUser?: Record<string, unknown>;
  /** Initial context. Default `{ kind: 'user', key: 'test-user' }`. */
  context?: EvalContext;
  /**
   * Whether the client is already ready on construction. Default true.
   * When false, reads return `source: 'not_ready'` until `_markReady()` is
   * called, which is what the real client does before its first datafile.
   */
  ready?: boolean;
}

export interface MockClient {
  // -- Lifecycle -----------------------------------------------------------
  onReady(options?: { timeout?: number }): Promise<InitResult>;
  isReady(): boolean;
  getInitResult(): InitResult | null;
  close(): Promise<void>;
  flush(): Promise<void>;
  refresh(): Promise<void>;

  // -- Identity ------------------------------------------------------------
  identify(ctx: EvalContext): void;
  updateAttributes(partial: Record<string, unknown>, kind?: string): void;
  /** Synchronous, like the real client: records one `avsb_alias` event. */
  alias(previousContext: EvalContext, newContext: EvalContext): void;
  getContext(): EvalContext;
  reset(): void;

  // -- Reading flags -------------------------------------------------------
  getFlag<T>(flagKey: string, defaultValue: T, options?: GetFlagOptions): Flag<T>;
  getBoolFlag(flagKey: string, defaultValue: boolean, options?: GetFlagOptions): Flag<boolean>;
  getStringFlag(flagKey: string, defaultValue: string, options?: GetFlagOptions): Flag<string>;
  getNumberFlag(flagKey: string, defaultValue: number, options?: GetFlagOptions): Flag<number>;
  getJsonFlag<T>(flagKey: string, defaultValue: T, options?: GetFlagOptions): Flag<T>;
  getAllFlags(options?: GetAllFlagsOptions): Record<string, Flag>;

  // -- Store contract ------------------------------------------------------
  subscribe(flagKey: string, listener: () => void): () => void;
  getSnapshot<T>(flagKey: string, defaultValue: T): Flag<T>;

  // -- Tracking ------------------------------------------------------------
  track(eventKey: string, payload?: TrackPayload): void;
  on<E extends ClientEventName>(event: E, cb: ClientEventMap[E]): () => void;
  /** The legacy three-argument flag-change listener, like the real client's. */
  onFlagChange(
    callback: (flagKey: string, newValue: unknown, previousValue: unknown) => void,
  ): () => void;

  // -- Runtime overrides ---------------------------------------------------
  setOverrideForUser(
    flagKey: string,
    contextKey: string,
    variationKey: string,
    contextKind?: string,
  ): void;
  setGlobalOverride(flagKey: string, variationKey: string): void;
  clearOverrideForUser(flagKey: string, contextKey: string, contextKind?: string): void;
  clearGlobalOverride(flagKey: string): void;
  clearAllOverrides(): void;

  // -- Bootstrap handoff ---------------------------------------------------
  /**
   * Adopt a datafile out of band. A mock reads values from its flags map, not
   * from a datafile, so this records the datafile, merges each flag's default
   * variation value into the map, marks the client ready, and wakes every
   * subscriber. `_datafile()` returns what was applied.
   */
  applyDatafileBootstrap(datafile: FlagDatafile): void;
  /**
   * Adopt server-evaluated values (the SSR snapshot handoff): each flag's
   * value joins the map, the mock becomes ready, and subscribers wake.
   */
  applySnapshot(snapshot: FlagSnapshot): void;

  // -- Helpers -------------------------------------------------------------
  /** The real `createUtils` helpers, bound to this mock (N1-10). */
  readonly utils: AvsbUtils;

  // -- Inspection (test-only) ----------------------------------------------
  /** Set a value and notify subscribers, as a datafile update would. */
  _setFlag(flagKey: string, value: unknown): void;
  /** Events tracked so far. */
  _tracked(): Array<{ eventKey: string; payload: TrackPayload | undefined }>;
  /** Evaluations recorded so far. */
  _evaluations(): EvaluationRecord[];
  /** Become ready, resolving `onReady`. */
  _markReady(result?: InitResult): void;
  /** The datafile passed to `applyDatafileBootstrap`, or null. */
  _datafile(): FlagDatafile | null;
  /** How many times `refresh()` was called. */
  _refreshCount(): number;
}
