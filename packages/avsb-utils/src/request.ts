// AsyncLocalStorage request scope. Eight framework middlewares each open
// an ALS scope per request; deeply nested code can call
// `getRequestClient()` / `getRequestDecisionLog()` without threading the
// user context through every signature.

import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  EvalContext,
  Flag,
  TrackPayload,
  DecisionLog,
} from '@avsbhq/core'

/**
 * The per-request client the middlewares put on `req.avsb` and hand back from
 * `getRequestClient()`.
 *
 * This is the full bound-client surface, not a two-method slice of it: the
 * documented pattern is `getRequestClient().getBoolFlag('my-flag', false)`
 * deep inside a service, and a narrower type made exactly that line fail to
 * compile while the docs taught it. `UserBoundClient` from `@avsbhq/node`
 * satisfies this structurally, and so does the server mock from
 * `@avsbhq/test`.
 */
export interface RequestBoundClient {
  getFlag<T = unknown>(flagKey: string, defaultValue: T): Flag<T>
  getBoolFlag(flagKey: string, defaultValue: boolean): Flag<boolean>
  getStringFlag(flagKey: string, defaultValue: string): Flag<string>
  getNumberFlag(flagKey: string, defaultValue: number): Flag<number>
  getJsonFlag<T>(flagKey: string, defaultValue: T): Flag<T>
  getAllFlags(): Record<string, Flag>
  track(eventKey: string, payload?: TrackPayload): void
  getDecisionLog?(): DecisionLog
}

export interface RequestScope {
  context: EvalContext
  client: RequestBoundClient
  decisionLog: DecisionLog | null
}

/**
 * ONE storage per process, found through the global registry rather than
 * through module identity.
 *
 * Why this is not just `new AsyncLocalStorage()`: the package publishes each
 * middleware as its own entry point with bundle splitting off, so
 * `@avsbhq/utils` and `@avsbhq/utils/middleware/express` each carry their own
 * copy of this module. Two copies means two storages: the middleware opened a
 * scope in one and `getRequestClient()` read the other, so the documented
 * `getRequestClient()` call inside a request handler always answered null. A
 * dual-package consumer (ESM barrel, CJS middleware) has the same split even
 * with one entry. The registry key is what makes every copy agree.
 */
const STORAGE_KEY = Symbol.for('avsb.utils.requestContextStorage')

type StorageHost = { [STORAGE_KEY]?: AsyncLocalStorage<RequestScope> }

function resolveStorage(): AsyncLocalStorage<RequestScope> {
  const host = globalThis as StorageHost
  const existing = host[STORAGE_KEY]
  if (existing) return existing
  const created = new AsyncLocalStorage<RequestScope>()
  host[STORAGE_KEY] = created
  return created
}

export const requestContextStorage = resolveStorage()

/**
 * Inside a request scope, returns the request-bound client. Outside,
 * returns null and the caller falls back to the per-call API.
 */
export function getRequestClient(): RequestBoundClient | null {
  return requestContextStorage.getStore()?.client ?? null
}

export function getRequestContext(): EvalContext | null {
  return requestContextStorage.getStore()?.context ?? null
}

export function getRequestDecisionLog(): DecisionLog | null {
  return requestContextStorage.getStore()?.decisionLog ?? null
}
