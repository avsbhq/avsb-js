// `client.utils.*` binding for AvsbServer. Spec §6.
//
// Server `getFlag` requires a context per call, but the `createUtils`
// helper layer expects a `(key, default)` signature. Most server-side
// utility usage happens within a per-request `forUser(ctx)` scope where
// the context is already bound — that's the canonical pattern.
//
// On the bare server (no bound context), helpers that need a context to
// evaluate (`snapshot`, `onFlagChange`, `waitForFlag`) will safely return
// not-found flags or no-op until the caller invokes them via
// `server.forUser(ctx).utils` (Workstream 5 wires that subpath when the
// multi-context evaluator lands).

import type { AvsbUtils, CreateUtilsClient } from '@avsbhq/utils'
import { createUtils } from '@avsbhq/utils'
import type {
  ClientEventMap,
  EvalContext,
  Flag,
  FlagDatafile,
  TrackPayload,
} from '@avsbhq/core'
import { notFoundFlag } from '@avsbhq/core'

export interface AvsbServerUtilsHost {
  getAllFlags(
    context?: EvalContext,
    options?: { fireExposures?: boolean }
  ): Record<string, Flag>
  getFlag<T>(flagKey: string, defaultValue: T, context?: EvalContext): Flag<T>
  track(
    eventKey: string,
    payload: TrackPayload & { context: EvalContext }
  ): void
  on(event: string, cb: unknown): () => void
  getDatafile(): FlagDatafile | null
  applyDatafileBootstrap(datafile: FlagDatafile): void
  refreshDatafile(): Promise<void>
}

export function buildServerUtils(server: AvsbServerUtilsHost): AvsbUtils {
  const adapter: CreateUtilsClient = {
    getFlag<T = unknown>(flagKey: string, defaultValue: T): Flag<T> {
      // No bound context at this level. Helpers that need one are documented
      // to run through `server.forUser(ctx)`; returning a not-found flag with
      // that exact reason beats guessing an identity.
      return notFoundFlag(
        defaultValue,
        'no bound context: call server.forUser(context) and use its flag methods'
      )
    },
    getAllFlags(opts?: {
      context?: EvalContext
      fireExposures?: boolean
    }): Record<string, Flag> {
      const ctx = opts?.context
      if (!ctx) return {}
      return server.getAllFlags(ctx, {
        fireExposures: opts.fireExposures,
      })
    },
    track(eventKey: string, payload?: TrackPayload): void {
      // Server-side track requires a context; the helper drops events that
      // arrive without one rather than silently mis-attributing them.
      if (!payload?.context) return
      server.track(eventKey, {
        ...payload,
        context: payload.context,
      })
    },
    on<E extends keyof ClientEventMap>(
      event: E,
      cb: ClientEventMap[E]
    ): () => void {
      return server.on(event, cb)
    },
    getDatafile: () => server.getDatafile(),
    getCurrentContext: () => null,
    /**
     * `snapshotFresh` and `refreshAndSnapshot` call this before they read, so
     * a "fresh" snapshot really is taken against the datafile published right
     * now. Without it both helpers quietly returned the in-memory datafile.
     */
    refresh: () => server.refreshDatafile(),
    /**
     * Real, not a comment: `client.utils.hydrateBootstrap(blob)` on the server
     * adopts the blob's datafile and marks the SDK ready. That is the
     * serverless cold-start path (read a datafile from KV or a file, hand it
     * over, evaluate on the same tick).
     */
    applyDatafile: (df) => server.applyDatafileBootstrap(df),
    // `applySnapshot` is deliberately ABSENT. A snapshot carries one context's
    // evaluated values, and this client evaluates a different context per
    // request, so adopting one process-wide would serve user A's values to user
    // B. hydrateBootstrap throws with that explanation when it is handed a
    // snapshot-only blob here, instead of quietly ignoring it.
  }
  return createUtils(adapter)
}
