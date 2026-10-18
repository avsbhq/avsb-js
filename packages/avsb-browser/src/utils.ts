// `client.utils.*` binding for AvsbClient. Spec §6.
//
// Browser client carries a bound `_context`, so the utils helpers can
// read+write `getFlag(key, default)` with the bound context implicitly.

import type { AvsbUtils, CreateUtilsClient, FlagSnapshot } from '@avsbhq/utils'
// VALUE import, so it comes from the leaf subpath. Importing `createUtils`
// from the root barrel dragged node-only modules into every browser bundle.
import { createUtils } from '@avsbhq/utils/createUtils'
import type {
  ClientEventMap,
  EvalContext,
  Flag,
  FlagDatafile,
  TrackPayload,
} from '@avsbhq/core'

export interface AvsbClientUtilsHost {
  getFlag<T>(flagKey: string, defaultValue: T): Flag<T>
  getAllFlags(options?: {
    fireExposures?: boolean
    context?: EvalContext
  }): Record<string, Flag>
  track(eventKey: string, payload?: TrackPayload): void
  on<E extends keyof ClientEventMap>(
    event: E,
    cb: ClientEventMap[E]
  ): () => void
  getContext(): EvalContext
  getDatafile(): FlagDatafile | null
  refreshDatafile?(): Promise<void>
  applyDatafileBootstrap?(df: FlagDatafile): void
  applySnapshot?(snap: FlagSnapshot): void
}

export function buildBrowserUtils(client: AvsbClientUtilsHost): AvsbUtils {
  const adapter: CreateUtilsClient = {
    getFlag: <T,>(flagKey: string, defaultValue: T): Flag<T> =>
      client.getFlag<T>(flagKey, defaultValue),
    // The `context` forward is the fix for report 02 §5.29: this adapter
    // used to drop it, so `client.utils.snapshot(ctx)` silently computed the
    // snapshot against the BOUND context. A server producing a snapshot for
    // user A could hand back user B's values.
    getAllFlags: (opts?: { fireExposures?: boolean; context?: EvalContext }) =>
      client.getAllFlags({
        fireExposures: opts?.fireExposures,
        context: opts?.context,
      }),
    track: (eventKey: string, payload?: TrackPayload) =>
      client.track(eventKey, payload),
    on: <E extends keyof ClientEventMap>(event: E, cb: ClientEventMap[E]) =>
      client.on(event, cb),
    getDatafile: () => client.getDatafile(),
    getCurrentContext: () => client.getContext(),
    refresh: client.refreshDatafile
      ? () => client.refreshDatafile!()
      : undefined,
    applyDatafile: client.applyDatafileBootstrap
      ? (df) => client.applyDatafileBootstrap!(df)
      : undefined,
    // The other half of the SSR handoff (report 02 §5.6). With this wired,
    // `client.utils.hydrateBootstrap(blob)` adopts server-evaluated values for
    // a blob serialised WITHOUT the datafile; without it the call did nothing
    // at all and the page silently fetched the datafile anyway.
    applySnapshot: client.applySnapshot
      ? (snap) => client.applySnapshot!(snap)
      : undefined,
  }
  return createUtils(adapter)
}
