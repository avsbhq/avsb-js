// =====================================================================
// `createMockClient` — the browser client's surface, answered from a map.
//
// It has to be the WHOLE surface, not a convenient subset. The framework
// adapters type their injection seams against the real client
// (`AngularAvsbClient` in @avsbhq/angular is the strictest: `AvsbService`
// calls `isReady()`, `getInitResult()` and `on('ready')` at construction),
// so a mock missing one method is not a weaker mock, it is a runtime
// TypeError the moment someone injects it. Everything the real
// `AvsbClient` exposes is here: lifecycle, identity, typed reads with
// `GetFlagOptions`, the store contract, tracking, runtime overrides, and
// the bootstrap handoff.
//
// For a REAL client over a fixture datafile (same evaluator, same snapshot
// caching, same exposure rules), use `createTestClient` instead. This mock
// is for the cases where you want to drive values directly and assert on
// what was asked for.
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
import { createEventBus } from '@avsbhq/core';
import type { EventBus } from '@avsbhq/core';
import type { GetFlagOptions, GetAllFlagsOptions } from '@avsbhq/browser';
import type { AvsbUtils } from '@avsbhq/utils';
import { createMockClientUtils } from './mockClientUtils';
import { createMockOverrideStore } from './mockOverrides';
import { createMockEvaluator, type EvaluationRecord } from './mockEvaluator';
import type { MockClient, MockClientOptions } from './mockClientTypes';

export type { MockClient, MockClientOptions } from './mockClientTypes';

type SubscribeListener = () => void;

const DEFAULT_CONTEXT: EvalContext = { kind: 'user', key: 'test-user' };

export function createMockClient(opts?: MockClientOptions): MockClient {
  const flagsMap: Record<string, unknown> = { ...(opts?.flags ?? {}) };
  const flagsByUser: Record<string, unknown> = { ...(opts?.flagsByUser ?? {}) };
  let currentContext: EvalContext = opts?.context ?? DEFAULT_CONTEXT;
  let isReadyNow = opts?.ready !== false;
  let initResult: InitResult | null = null;
  let datafile: FlagDatafile | null = null;
  let refreshCount = 0;
  let utils: AvsbUtils | null = null;

  const bus: EventBus = createEventBus();
  const overrides = createMockOverrideStore();
  const trackedEvents: Array<{ eventKey: string; payload: TrackPayload | undefined }> = [];
  const evaluations: EvaluationRecord[] = [];
  const subscribeListeners = new Map<string, Set<SubscribeListener>>();

  // Ready promise management
  let readyResolve: ((result: InitResult) => void) | null = null;
  let readyPromise: Promise<InitResult>;

  if (isReadyNow) {
    initResult = { success: true, source: 'bootstrap' };
    readyPromise = Promise.resolve<InitResult>(initResult);
  } else {
    readyPromise = new Promise<InitResult>((resolve) => {
      readyResolve = resolve;
    });
  }

  // The read path (override, then per-user value, then the flags map, then
  // not_found) lives in one place so five typed getters cannot drift apart.
  // `flagsMap` and `evaluations` are shared BY REFERENCE, so `_setFlag` and
  // `applyDatafileBootstrap` are visible to it without a re-wire.
  const evaluator = createMockEvaluator({
    flags: flagsMap,
    flagsByUser,
    overrides,
    bus,
    evaluations,
    isReady: () => isReadyNow,
  });
  const { evalFlag, contextKeyOf } = evaluator;

  function notifySubscribers(flagKey: string): void {
    const listeners = subscribeListeners.get(flagKey);
    if (!listeners) return;
    for (const listener of listeners) listener();
  }

  /**
   * `readOnly` is the only member of `GetFlagOptions` a mock can honour.
   * `fireExposure` and `decideOptions` are accepted so this matches the real
   * `GetFlagOptions` signature, and are INERT: a mock has no exposure
   * pipeline to suppress. Use `createTestClient` when the exposure behaviour
   * is the thing under test.
   */
  function isReadOnly(options?: GetFlagOptions): boolean {
    return options?.readOnly === true;
  }

  const client: MockClient = {
    // -- Lifecycle ---------------------------------------------------------

    onReady(options?: { timeout?: number }): Promise<InitResult> {
      const timeout = options?.timeout;
      if (!timeout || timeout <= 0) return readyPromise;
      return new Promise<InitResult>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          resolve(
            isReadyNow
              ? { success: true, degraded: true, source: 'timeout' }
              : { success: false, source: 'timeout' },
          );
        }, timeout);
        void readyPromise.then((result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        });
      });
    },

    isReady(): boolean {
      return isReadyNow;
    },

    getInitResult(): InitResult | null {
      return initResult;
    },

    async close(): Promise<void> {
      subscribeListeners.clear();
    },

    async flush(): Promise<void> {
      // No transport, so nothing to drain.
    },

    async refresh(): Promise<void> {
      refreshCount += 1;
      bus.emit('configUpdate', { publishedAt: new Date().toISOString(), reason: 'manual' });
    },

    // -- Identity ----------------------------------------------------------

    identify(ctx: EvalContext): void {
      currentContext = ctx;
      for (const key of subscribeListeners.keys()) notifySubscribers(key);
      bus.emit('configUpdate', { publishedAt: new Date().toISOString(), reason: 'manual' });
    },

    updateAttributes(partial: Record<string, unknown>, kind?: string): void {
      if (currentContext.kind === 'multi') {
        // For multi-context, update the specified kind or 'user'
        const targetKind = kind ?? 'user';
        const existing = (currentContext as Record<string, unknown>)[targetKind];
        if (existing && typeof existing === 'object') {
          currentContext = {
            ...currentContext,
            [targetKind]: { ...(existing as object), ...partial },
          } as EvalContext;
        }
      } else {
        currentContext = { ...currentContext, ...partial } as EvalContext;
      }
    },

    alias(_previousContext: EvalContext, _newContext: EvalContext): void {
      // Synchronous and honest, exactly like the real client: one event
      // attributed to the identity this client is bound to. There is no
      // retroactive rewrite of past events anywhere in the platform.
      client.track('avsb_alias');
    },

    getContext(): EvalContext {
      return currentContext;
    },

    reset(): void {
      currentContext = opts?.context ?? DEFAULT_CONTEXT;
      overrides.clearAll();
      trackedEvents.length = 0;
      evaluations.length = 0;
    },

    // -- Reading flags -----------------------------------------------------

    getFlag<T>(flagKey: string, defaultValue: T, options?: GetFlagOptions): Flag<T> {
      return evalFlag(flagKey, defaultValue, currentContext, !isReadOnly(options));
    },

    getBoolFlag(flagKey: string, defaultValue: boolean, options?: GetFlagOptions): Flag<boolean> {
      return evalFlag(flagKey, defaultValue, currentContext, !isReadOnly(options));
    },

    getStringFlag(flagKey: string, defaultValue: string, options?: GetFlagOptions): Flag<string> {
      return evalFlag(flagKey, defaultValue, currentContext, !isReadOnly(options));
    },

    getNumberFlag(flagKey: string, defaultValue: number, options?: GetFlagOptions): Flag<number> {
      return evalFlag(flagKey, defaultValue, currentContext, !isReadOnly(options));
    },

    getJsonFlag<T>(flagKey: string, defaultValue: T, options?: GetFlagOptions): Flag<T> {
      return evalFlag(flagKey, defaultValue, currentContext, !isReadOnly(options));
    },

    getAllFlags(options?: GetAllFlagsOptions): Record<string, Flag> {
      const ctx = options?.context ?? currentContext;
      const result: Record<string, Flag> = {};
      const allKeys = new Set<string>([...Object.keys(flagsMap), ...overrides.keys()]);

      // Include per-user keys for the context being evaluated.
      const userKey = contextKeyOf(ctx);
      for (const k of Object.keys(flagsByUser)) {
        const colonIdx = k.lastIndexOf(':');
        if (colonIdx !== -1 && k.slice(colonIdx + 1) === userKey) {
          allKeys.add(k.slice(0, colonIdx));
        }
      }

      // A bulk read is exposure-OFF by default, matching the real client.
      const record = options?.fireExposures === true;
      for (const flagKey of allKeys) {
        result[flagKey] = evalFlag(flagKey, undefined, ctx, record);
      }
      return result;
    },

    // -- Store contract ----------------------------------------------------

    subscribe(flagKey: string, listener: SubscribeListener): () => void {
      if (!subscribeListeners.has(flagKey)) {
        subscribeListeners.set(flagKey, new Set());
      }
      subscribeListeners.get(flagKey)?.add(listener);
      return () => {
        subscribeListeners.get(flagKey)?.delete(listener);
      };
    },

    getSnapshot<T>(flagKey: string, defaultValue: T): Flag<T> {
      // Render-safe: no exposure, no evaluation event.
      return evalFlag(flagKey, defaultValue, currentContext, false);
    },

    // -- Tracking ----------------------------------------------------------

    track(eventKey: string, payload?: TrackPayload): void {
      trackedEvents.push({ eventKey, payload });
    },

    on<E extends ClientEventName>(event: E, cb: ClientEventMap[E]): () => void {
      return bus.on(event, cb);
    },

    onFlagChange(callback): () => void {
      return bus.on('flagChange', (data) => {
        callback(data.flagKey, data.newValue, data.previousValue);
      });
    },

    // -- Runtime overrides -------------------------------------------------

    setOverrideForUser(
      flagKey: string,
      contextKey: string,
      variationKey: string,
      contextKind = 'user',
    ): void {
      overrides.setForContext(flagKey, contextKey, variationKey, contextKind);
      notifySubscribers(flagKey);
    },

    setGlobalOverride(flagKey: string, variationKey: string): void {
      overrides.setGlobal(flagKey, variationKey);
      notifySubscribers(flagKey);
    },

    clearOverrideForUser(flagKey: string, contextKey: string, contextKind = 'user'): void {
      overrides.clearForContext(flagKey, contextKey, contextKind);
      notifySubscribers(flagKey);
    },

    clearGlobalOverride(flagKey: string): void {
      overrides.clearGlobal(flagKey);
      notifySubscribers(flagKey);
    },

    clearAllOverrides(): void {
      const touched = overrides.keys();
      overrides.clearAll();
      for (const flagKey of touched) notifySubscribers(flagKey);
    },

    // -- Bootstrap handoff -------------------------------------------------

    applyDatafileBootstrap(incoming: FlagDatafile): void {
      datafile = incoming;
      for (const entry of incoming.flags) {
        const variation = entry.variations.find((v) => v.id === entry.defaultVariationId);
        if (variation) flagsMap[entry.key] = variation.value;
      }
      client._markReady({ success: true, source: 'bootstrap' });
      for (const key of subscribeListeners.keys()) notifySubscribers(key);
    },

    applySnapshot(snapshot): void {
      for (const [flagKey, flag] of Object.entries(snapshot.flags)) {
        if (flag) flagsMap[flagKey] = flag.value;
      }
      if (!isReadyNow) client._markReady({ success: true, source: 'bootstrap' });
      for (const key of subscribeListeners.keys()) notifySubscribers(key);
    },

    get utils(): AvsbUtils {
      utils ??= createMockClientUtils({
        getFlag: (flagKey, defaultValue) => client.getFlag(flagKey, defaultValue),
        getAllFlags: (options) => client.getAllFlags(options),
        track: (eventKey, payload) => client.track(eventKey, payload),
        on: (event, cb) => client.on(event, cb),
        getContext: () => client.getContext(),
        refresh: () => client.refresh(),
        applyDatafileBootstrap: (incoming) => client.applyDatafileBootstrap(incoming),
        applySnapshot: (snapshot) => client.applySnapshot(snapshot),
        datafile: () => datafile,
      });
      return utils;
    },

    // -- Inspection --------------------------------------------------------

    _setFlag(flagKey: string, value: unknown): void {
      const previousValue = flagsMap[flagKey];
      flagsMap[flagKey] = value;
      notifySubscribers(flagKey);
      bus.emit('flagChange', { flagKey, previousValue, newValue: value });
    },

    _tracked(): Array<{ eventKey: string; payload: TrackPayload | undefined }> {
      return [...trackedEvents];
    },

    _evaluations(): EvaluationRecord[] {
      return [...evaluations];
    },

    _markReady(result?: InitResult): void {
      const resolvedResult: InitResult = result ?? { success: true, source: 'network' };
      isReadyNow = true;
      initResult = resolvedResult;

      if (readyResolve) {
        readyResolve(resolvedResult);
        readyResolve = null;
      } else {
        // Already resolved — replace with a new resolved promise
        readyPromise = Promise.resolve(resolvedResult);
      }

      bus.emit('ready', resolvedResult);
    },

    _datafile(): FlagDatafile | null {
      return datafile;
    },

    _refreshCount(): number {
      return refreshCount;
    },
  };

  return client;
}
