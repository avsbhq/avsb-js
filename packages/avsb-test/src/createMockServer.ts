// =====================================================================
// A server-shaped mock: the whole `AvsbServer` surface, including `forUser`.
//
// `createMockClient` mirrors the BROWSER client (bound context, `identify`,
// `subscribe`). A node consumer testing a request handler needs the other
// shape: context passed per call or bound with `forUser(ctx)`, `track` with the
// context in the payload, and purchases. Report 02 §6 named the gap ("no
// forUser-shaped mock for AvsbServer consumers, and no documented DI seam").
//
// N1-10 (production QA 2026-10-01): the README said it "Mirrors AvsbServer"
// while `alias`, the five override methods, `on`/`off`, `refreshDatafile`,
// `applyDatafileBootstrap`, `getDatafile`, `createDecisionLog` and the
// `utils`/`datasets`/`recs` properties were missing, so code calling any of
// them threw a TypeError under the mock. They are all here now, and
// createMockServer.surface.test.ts compares the method names with the real
// class. Types: ./mockServerTypes. Events, datasets, recs, utils:
// ./mockServerExtras.
//
// It answers from the same fixture state as `createMockClient`, through the
// same resolver, so one `flagsFromTestData(...)` fixture drives both.
// =====================================================================

import type {
  DecisionLog,
  DecisionLogEntry,
  EvalContext,
  Flag,
  FlagDatafile,
  InitResult,
  TrackPayload,
} from '@avsbhq/core'
import { createFlag, notFoundFlag, notReadyFlag, contextSummary } from '@avsbhq/core'
import { createMockFlagResolver } from './mockFlags'
import { createMockOverrideStore } from './mockOverrides'
import {
  createMockDatasets,
  createMockRecs,
  createMockServerEvents,
  createMockServerUtils,
  type MockRecClick,
} from './mockServerExtras'
import type {
  MockBoundClient,
  MockPurchaseOrder,
  MockServer,
  MockServerOptions,
} from './mockServerTypes'

export type {
  MockBoundClient,
  MockDatasetGetResult,
  MockPurchaseOrder,
  MockRecProduct,
  MockServer,
  MockServerEventMap,
  MockServerEventName,
  MockServerOptions,
} from './mockServerTypes'

/** How one read is decided before its flag is built. */
type Decision = { kind: 'forced'; variationKey: string } | { kind: 'normal' }

const NORMAL: Decision = { kind: 'normal' }

export function createMockServer(options?: MockServerOptions): MockServer {
  // `flagsMap` mirrors the resolver's fallthrough values so the override store
  // can resolve a variation key against them, exactly as createMockClient does.
  const flagsMap: Record<string, unknown> = { ...(options?.flags ?? {}) }
  const resolver = createMockFlagResolver({
    flags: flagsMap,
    flagsByUser: options?.flagsByUser ?? {},
  })
  const overrides = createMockOverrideStore()
  const events = createMockServerEvents()
  let isReady = options?.ready !== false
  let datafile: FlagDatafile | null = null
  let refreshCount = 0

  const tracked: Array<{ eventKey: string; payload: TrackPayload | undefined; contextKey: string }> =
    []
  const purchases: Array<{ visitorId: string; order: MockPurchaseOrder }> = []
  const evaluations: Array<{ flagKey: string; value: unknown; contextKey: string }> = []
  const exposures: Array<{ flagKey: string; contextKey: string; manual: boolean }> = []
  const recClicks: MockRecClick[] = []

  let readyResolve: ((result: InitResult) => void) | null = null
  let readyPromise: Promise<InitResult> = isReady
    ? Promise.resolve<InitResult>({ success: true, source: 'bootstrap' })
    : new Promise<InitResult>((resolve) => {
        readyResolve = resolve
      })

  function setFlagValue(flagKey: string, value: unknown): void {
    flagsMap[flagKey] = value
    resolver.set(flagKey, value)
  }

  function decide<T>(flagKey: string, defaultValue: T, context: EvalContext, decision: Decision): Flag<T> {
    if (decision.kind === 'forced') {
      // A forced decision serves its variation key, the rule the override
      // store follows for a key the fixture holds no value for. It used to
      // serve the normal value relabelled as runtimeOverride.
      return createFlag<T>({
        value: decision.variationKey as unknown as T,
        variationKey: decision.variationKey,
        source: 'runtimeOverride',
        ruleId: null,
        ruleType: null,
        reasons: [`forced decision: variationKey="${decision.variationKey}"`],
      })
    }
    const overridden = overrides.resolve<T>(flagKey, context, flagsMap)
    if (overridden) return overridden
    const resolved = resolver.resolve(flagKey, defaultValue, context)
    return resolved.found
      ? createFlag<T>({
          value: resolved.value as T,
          variationKey: 'mock-variation',
          source: 'rule',
          ruleId: 'mock',
          ruleType: 'ab_test',
          reasons: ['mock flag'],
        })
      : notFoundFlag(defaultValue, 'no mock flag')
  }

  function evaluate<T>(
    flagKey: string,
    defaultValue: T,
    context: EvalContext | undefined,
    decision: Decision = NORMAL,
    log?: DecisionLog
  ): Flag<T> {
    if (!context) {
      return notReadyFlag(
        defaultValue,
        'no context passed; call server.forUser(context) or pass the context positionally'
      )
    }
    if (!isReady) return notReadyFlag(defaultValue, 'SDK not ready: no datafile loaded yet')

    const contextKey = resolver.keyOf(context)
    const flag = decide(flagKey, defaultValue, context, decision)

    evaluations.push({ flagKey, value: flag.value, contextKey })
    if (flag.source === 'rule') exposures.push({ flagKey, contextKey, manual: false })
    events.emit('evaluation', {
      flagKey,
      flag: flag as Flag,
      contextKeys: contextSummary(context).map((entry) => entry.key),
    })
    if (log) {
      ;(log.entries as DecisionLogEntry[]).push({
        flagKey,
        value: flag.value,
        variationKey: flag.variationKey,
        source: flag.source,
        ruleId: flag.ruleId,
        ruleType: flag.ruleType,
        reasons: [...flag.reasons],
        evaluatedAt: flag.evaluatedAt,
        durationMicros: flag.durationMicros,
        contextSummary: contextSummary(context),
      })
    }
    return flag
  }

  function allFlags(context: EvalContext | undefined, log?: DecisionLog): Record<string, Flag> {
    if (!context || !isReady) return {}
    const out: Record<string, Flag> = {}
    const keys = new Set([...resolver.keysFor(context), ...overrides.keys()])
    for (const flagKey of keys) {
      out[flagKey] = evaluate<unknown>(flagKey, undefined, context, NORMAL, log)
    }
    return out
  }

  function recordTrack(eventKey: string, payload: TrackPayload | undefined, context: EvalContext): void {
    tracked.push({ eventKey, payload, contextKey: resolver.keyOf(context) })
  }

  const server: MockServer = {
    onReady: () => readyPromise,
    isReady: () => isReady,
    async flush(): Promise<void> {},
    async close(): Promise<void> {},

    async refreshDatafile(): Promise<void> {
      refreshCount += 1
      events.emit('configUpdate', {
        publishedAt: datafile?.publishedAt ?? new Date(0).toISOString(),
        reason: 'manual',
      })
    },

    applyDatafileBootstrap(incoming: FlagDatafile): void {
      datafile = incoming
      for (const entry of incoming.flags) {
        const variation = entry.variations.find((v) => v.id === entry.defaultVariationId)
        if (variation) setFlagValue(entry.key, variation.value)
      }
      if (!isReady) {
        server._markReady({ success: true, source: 'bootstrap' })
        return
      }
      events.emit('configUpdate', { publishedAt: incoming.publishedAt, reason: 'manual' })
    },

    getDatafile: () => datafile,

    getFlag: (flagKey, defaultValue, context) => evaluate(flagKey, defaultValue, context),
    getBoolFlag: (flagKey, defaultValue, context) => evaluate(flagKey, defaultValue, context),
    getStringFlag: (flagKey, defaultValue, context) => evaluate(flagKey, defaultValue, context),
    getNumberFlag: (flagKey, defaultValue, context) => evaluate(flagKey, defaultValue, context),
    getJsonFlag: (flagKey, defaultValue, context) => evaluate(flagKey, defaultValue, context),
    getAllFlags: (context, opts) => allFlags(context, opts?.decisionLog),

    track(eventKey, payload): void {
      recordTrack(eventKey, payload, payload.context)
    },

    async trackPurchase(visitorId, order): Promise<void> {
      purchases.push({ visitorId, order })
    },

    alias(_previousContext, newContext): void {
      recordTrack('avsb_alias', undefined, newContext)
    },

    manualExposure(flagKey, context): void {
      exposures.push({ flagKey, contextKey: resolver.keyOf(context), manual: true })
    },

    forUser(context): MockBoundClient {
      const decisionLog: DecisionLog = { entries: [] }
      const forced = new Map<string, { variationKey: string }>()

      const bound = <T,>(flagKey: string, defaultValue: T): Flag<T> => {
        const forcedDecision = forced.get(flagKey)
        const decision: Decision = forcedDecision
          ? { kind: 'forced', variationKey: forcedDecision.variationKey }
          : NORMAL
        return evaluate<T>(flagKey, defaultValue, context, decision, decisionLog)
      }

      return {
        getFlag: bound,
        getBoolFlag: (flagKey, defaultValue) => bound(flagKey, defaultValue),
        getStringFlag: (flagKey, defaultValue) => bound(flagKey, defaultValue),
        getNumberFlag: (flagKey, defaultValue) => bound(flagKey, defaultValue),
        getJsonFlag: (flagKey, defaultValue) => bound(flagKey, defaultValue),
        getAllFlags: () => allFlags(context, decisionLog),
        track(eventKey, payload): void {
          recordTrack(eventKey, payload, context)
        },
        trackPurchase(order): Promise<void> {
          return server.trackPurchase(resolver.keyOf(context), order)
        },
        manualExposure(flagKey): void {
          server.manualExposure(flagKey, context)
        },
        getContext: () => context,
        setForcedDecision(flagKey, opts): void {
          forced.set(flagKey, { variationKey: opts.variationKey })
        },
        clearForcedDecision(flagKey): void {
          forced.delete(flagKey)
        },
        getDecisionLog: () => decisionLog,
      }
    },

    createUserContext(context): MockBoundClient {
      return server.forUser(context)
    },

    setOverrideForUser(flagKey, contextKey, variationKey, contextKind = 'user'): void {
      overrides.setForContext(flagKey, contextKey, variationKey, contextKind)
    },
    setGlobalOverride(flagKey, variationKey): void {
      overrides.setGlobal(flagKey, variationKey)
    },
    clearOverrideForUser(flagKey, contextKey, contextKind = 'user'): void {
      overrides.clearForContext(flagKey, contextKey, contextKind)
    },
    clearGlobalOverride(flagKey): void {
      overrides.clearGlobal(flagKey)
    },
    clearAllOverrides(): void {
      overrides.clearAll()
    },

    createDecisionLog: () => ({ entries: [] }),
    on: (event, cb) => events.on(event, cb),
    off: (event, cb) => events.off(event, cb),

    utils: createMockServerUtils({
      getAllFlags: (context) => allFlags(context),
      track: (eventKey, payload) => recordTrack(eventKey, payload, payload.context),
      on: (event, cb) =>
        events.on(
          event as Parameters<typeof events.on>[0],
          cb as Parameters<typeof events.on>[1]
        ),
      getDatafile: () => datafile,
      applyDatafileBootstrap: (incoming) => server.applyDatafileBootstrap(incoming),
      refreshDatafile: () => server.refreshDatafile(),
    }),
    datasets: createMockDatasets(options?.datasets),
    recs: createMockRecs(options?.recs, recClicks),

    _setFlag(flagKey, value): void {
      setFlagValue(flagKey, value)
    },
    _tracked: () => [...tracked],
    _purchases: () => [...purchases],
    _evaluations: () => [...evaluations],
    _exposures: () => [...exposures],
    _recClicks: () => [...recClicks],
    _refreshCount: () => refreshCount,
    _markReady(result?: InitResult): void {
      const resolved: InitResult = result ?? { success: true, source: 'network' }
      isReady = true
      if (readyResolve) {
        readyResolve(resolved)
        readyResolve = null
      } else {
        readyPromise = Promise.resolve(resolved)
      }
      events.emit('ready')
    },
  }

  return server
}
