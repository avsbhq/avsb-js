import type {
  DecideOption,
  DecisionLog,
  EvalContext,
  Flag,
  TrackPayload,
} from '@avsbhq/core'
import { bucketingKey } from '@avsbhq/core'
import { createDecisionLog } from './decisionLog'
import type { AvsbServer } from './AvsbServer'
import type { GetAllFlagsOptions, ServerGetFlagOptions } from './types'
import type { PurchaseOrder } from './serverTracker'

/**
 * A per-request client with a bound `EvalContext`. THE primary server pattern:
 * bind the context once at the edge of the request, then read flags anywhere
 * inside it without threading identity through every signature.
 *
 * Created via `server.forUser(ctx)` or the `server.createUserContext(ctx)`
 * alias. Every flag and track call uses the bound context, and the instance
 * carries its own decision log.
 *
 * Forced decisions set here live only for the lifetime of this instance; they
 * never touch the shared `AvsbServer` override state, which is what makes them
 * safe in test middleware and per-request debugging.
 */
export interface UserBoundClient {
  /** Evaluate against the bound context. Returns `Flag<T>`, never a raw value. */
  getFlag<T>(
    flagKey: string,
    defaultValue: T,
    options?: ServerGetFlagOptions
  ): Flag<T>
  /** Type-checked against the datafile's declared flag type; falls back to the default on a mismatch. */
  getBoolFlag(
    flagKey: string,
    defaultValue: boolean,
    options?: ServerGetFlagOptions
  ): Flag<boolean>
  getStringFlag(
    flagKey: string,
    defaultValue: string,
    options?: ServerGetFlagOptions
  ): Flag<string>
  getNumberFlag(
    flagKey: string,
    defaultValue: number,
    options?: ServerGetFlagOptions
  ): Flag<number>
  getJsonFlag<T>(
    flagKey: string,
    defaultValue: T,
    options?: ServerGetFlagOptions
  ): Flag<T>
  /** Every flag in the environment for the bound context. Exposures off by default. */
  getAllFlags(options?: GetAllFlagsOptions): Record<string, Flag>
  /** Queue a metric event attributed to the bound context. */
  track(eventKey: string, payload?: Omit<TrackPayload, 'context'>): void
  /** Send a purchase attributed to the bound context's bucketing key. */
  trackPurchase(order: PurchaseOrder): Promise<void>
  /** Record an exposure for a decision the visitor has now actually seen. */
  manualExposure(flagKey: string): void
  /** The context this client is bound to. */
  getContext(): EvalContext
  setForcedDecision(
    flagKey: string,
    opts: { ruleId?: string; variationKey: string }
  ): void
  clearForcedDecision(flagKey: string): void
  /** Every decision this request made, redacted per the context's private attributes. */
  getDecisionLog(): DecisionLog
}

/** Internal shape stored for each forced decision. */
interface ForcedDecision {
  ruleId?: string
  variationKey: string
}

type TypedGetter = 'boolean' | 'string' | 'number' | 'json'

export function createUserBoundClient(
  server: AvsbServer,
  context: EvalContext
): UserBoundClient {
  const decisionLog = createDecisionLog()
  const forcedDecisions = new Map<string, ForcedDecision>()

  function evaluate<T>(
    flagKey: string,
    defaultValue: T,
    expectedType: TypedGetter | undefined,
    options?: { decideOptions?: DecideOption[]; decisionLog?: DecisionLog }
  ): Flag<T> {
    const forced = forcedDecisions.get(flagKey)
    return server.evaluateInternal<T>(flagKey, defaultValue, context, {
      decideOptions: options?.decideOptions,
      // A caller may point one evaluation at their own log; the bound log is
      // the default so `getDecisionLog()` is complete without extra wiring.
      decisionLog: options?.decisionLog ?? decisionLog,
      ...(expectedType ? { expectedType } : {}),
      ...(forced ? { forcedVariationKey: forced.variationKey } : {}),
    })
  }

  return {
    getFlag<T>(flagKey: string, defaultValue: T, options?: ServerGetFlagOptions): Flag<T> {
      return evaluate<T>(flagKey, defaultValue, undefined, options)
    },

    getBoolFlag(flagKey, defaultValue, options?): Flag<boolean> {
      return evaluate<boolean>(flagKey, defaultValue, 'boolean', options)
    },

    getStringFlag(flagKey, defaultValue, options?): Flag<string> {
      return evaluate<string>(flagKey, defaultValue, 'string', options)
    },

    getNumberFlag(flagKey, defaultValue, options?): Flag<number> {
      return evaluate<number>(flagKey, defaultValue, 'number', options)
    },

    getJsonFlag<T>(flagKey: string, defaultValue: T, options?: ServerGetFlagOptions): Flag<T> {
      return evaluate<T>(flagKey, defaultValue, 'json', options)
    },

    getAllFlags(options?): Record<string, Flag> {
      return server.getAllFlags(context, {
        ...options,
        decisionLog: options?.decisionLog ?? decisionLog,
      })
    },

    track(eventKey, payload?): void {
      server.track(eventKey, { ...payload, context })
    },

    trackPurchase(order): Promise<void> {
      // Orders are attributed to the same bucketing key the exposures used, so
      // revenue joins the decisions this request made.
      return server.trackPurchase(bucketingKey(context), order)
    },

    manualExposure(flagKey): void {
      server.manualExposure(flagKey, context)
    },

    getContext(): EvalContext {
      return context
    },

    setForcedDecision(flagKey, opts): void {
      forcedDecisions.set(flagKey, opts)
    },

    clearForcedDecision(flagKey): void {
      forcedDecisions.delete(flagKey)
    },

    getDecisionLog(): DecisionLog {
      return decisionLog
    },
  }
}
