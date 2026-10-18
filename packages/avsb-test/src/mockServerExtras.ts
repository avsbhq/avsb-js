// =====================================================================
// The parts of the server mock that are not flag reads: the event bus,
// `datasets`, `recs` and `utils` (N1-10). Split from createMockServer.ts so
// the factory stays readable.
// =====================================================================

import type {
  ClientEventMap,
  EvalContext,
  Flag,
  FlagDatafile,
  TrackPayload,
} from '@avsbhq/core'
import { notFoundFlag } from '@avsbhq/core'
import { createUtils } from '@avsbhq/utils'
import type { AvsbUtils, CreateUtilsClient } from '@avsbhq/utils'
import type {
  MockDatasetsClient,
  MockRecProduct,
  MockRecsClient,
  MockServerEventMap,
  MockServerEventName,
} from './mockServerTypes'

// ---------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------

export interface MockServerEvents {
  on<E extends MockServerEventName>(event: E, cb: MockServerEventMap[E]): () => void
  off<E extends MockServerEventName>(event: E, cb: MockServerEventMap[E]): void
  emit<E extends MockServerEventName>(event: E, ...args: Parameters<MockServerEventMap[E]>): void
}

/** Same contract as AvsbServer's bus: listener errors never escape `emit`. */
export function createMockServerEvents(): MockServerEvents {
  const listeners = new Map<MockServerEventName, Set<unknown>>()
  return {
    on(event, cb) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(cb)
      return () => {
        listeners.get(event)?.delete(cb)
      }
    },
    off(event, cb) {
      listeners.get(event)?.delete(cb)
    },
    emit(event, ...args) {
      for (const cb of listeners.get(event) ?? []) {
        try {
          ;(cb as (...a: typeof args) => void)(...args)
        } catch {
          // A throwing test listener must not break the code under test,
          // exactly as the real server swallows (and logs) listener errors.
        }
      }
    },
  }
}

// ---------------------------------------------------------------------
// datasets and recs
// ---------------------------------------------------------------------

/** Fixed version reported for every fixture dataset hit. */
const MOCK_DATASET_VERSION = 1

export function createMockDatasets(
  datasets: Record<string, Record<string, unknown>> = {}
): MockDatasetsClient {
  return {
    async get(slug, key) {
      const table = datasets[slug]
      if (!table) return { found: false, meta: { slug, version: null } }
      if (!(key in table)) return { found: false, meta: { slug, version: MOCK_DATASET_VERSION } }
      return { found: true, value: table[key], meta: { slug, version: MOCK_DATASET_VERSION } }
    },
  }
}

export interface MockRecClick {
  productId: string
  recipe: string | undefined
  visitorId: string
}

export function createMockRecs(
  recs: Record<string, MockRecProduct[]> = {},
  clicks: MockRecClick[]
): MockRecsClient {
  return {
    async get(req) {
      const all = recs[req.recipe] ?? []
      const items = typeof req.maxItems === 'number' ? all.slice(0, req.maxItems) : [...all]
      return {
        items,
        served: items.length > 0,
        recipe: req.recipe,
        source: items.length > 0 ? 'mock' : null,
        fallbackStep: items.length > 0 ? 0 : null,
        degraded: false,
      }
    },
    trackClick(productId, opts) {
      clicks.push({ productId, recipe: opts.recipe, visitorId: opts.visitorId })
    },
  }
}

// ---------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------

/** What the utils binding needs from the mock server. */
export interface MockUtilsHost {
  getAllFlags(context?: EvalContext, options?: { fireExposures?: boolean }): Record<string, Flag>
  track(eventKey: string, payload: TrackPayload & { context: EvalContext }): void
  on(event: string, cb: unknown): () => void
  getDatafile(): FlagDatafile | null
  applyDatafileBootstrap(datafile: FlagDatafile): void
  refreshDatafile(): Promise<void>
}

/**
 * The REAL `createUtils` helpers bound to the mock, wired the way
 * @avsbhq/node's `buildServerUtils` wires them: with no bound context at the
 * server level, a bare `getFlag` answers not_found naming `forUser`, and
 * `track` drops an event that carries no context rather than misattribute it.
 */
export function createMockServerUtils(host: MockUtilsHost): AvsbUtils {
  const adapter: CreateUtilsClient = {
    getFlag<T = unknown>(_flagKey: string, defaultValue: T): Flag<T> {
      return notFoundFlag(
        defaultValue,
        'no bound context: call server.forUser(context) and use its flag methods'
      )
    },
    getAllFlags(opts?: { context?: EvalContext; fireExposures?: boolean }): Record<string, Flag> {
      if (!opts?.context) return {}
      return host.getAllFlags(opts.context, { fireExposures: opts.fireExposures })
    },
    track(eventKey: string, payload?: TrackPayload): void {
      if (!payload?.context) return
      host.track(eventKey, { ...payload, context: payload.context })
    },
    on<E extends keyof ClientEventMap>(event: E, cb: ClientEventMap[E]): () => void {
      return host.on(event, cb)
    },
    getDatafile: () => host.getDatafile(),
    getCurrentContext: () => null,
    applyDatafile: (datafile: FlagDatafile) => host.applyDatafileBootstrap(datafile),
    // `refresh` goes through the mock's own `refreshDatafile`, exactly as the
    // real adapter calls `AvsbServer.refreshDatafile`: the call is counted
    // (`_refreshCount`) and fires `configUpdate`, so a test can assert that
    // `snapshotFresh` really refreshed. Mock reads are live, so the snapshot
    // taken after it reflects every `_setFlag` and `applyDatafileBootstrap`.
    refresh: () => host.refreshDatafile(),
    // No `applySnapshot`, exactly like the real server: a snapshot is one
    // context's values, and a server serves many.
  }
  return createUtils(adapter)
}
