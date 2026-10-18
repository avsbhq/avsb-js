// =====================================================================
// `utils` for the browser-shaped mock (N1-10): the REAL `createUtils`
// helpers, wired to the mock the way @avsbhq/browser's buildBrowserUtils
// wires them to AvsbClient, so `client.utils.snapshot(ctx)`,
// `hydrateBootstrap(blob)` and friends behave under the mock as they do in
// production.
// =====================================================================

import type { ClientEventMap, EvalContext, Flag, FlagDatafile, TrackPayload } from '@avsbhq/core'
import { createUtils } from '@avsbhq/utils'
import type { AvsbUtils, CreateUtilsClient, FlagSnapshot } from '@avsbhq/utils'

/** What the binding needs from the mock client. */
export interface MockClientUtilsHost {
  getFlag<T>(flagKey: string, defaultValue: T): Flag<T>
  getAllFlags(options?: { fireExposures?: boolean; context?: EvalContext }): Record<string, Flag>
  track(eventKey: string, payload?: TrackPayload): void
  on<E extends keyof ClientEventMap>(event: E, cb: ClientEventMap[E]): () => void
  getContext(): EvalContext
  refresh(): Promise<void>
  applyDatafileBootstrap(datafile: FlagDatafile): void
  applySnapshot(snapshot: FlagSnapshot): void
  /** The datafile the mock was given, or null. */
  datafile(): FlagDatafile | null
}

export function createMockClientUtils(host: MockClientUtilsHost): AvsbUtils {
  const adapter: CreateUtilsClient = {
    getFlag: <T,>(flagKey: string, defaultValue: T): Flag<T> => host.getFlag<T>(flagKey, defaultValue),
    getAllFlags: (opts?: { fireExposures?: boolean; context?: EvalContext }) =>
      host.getAllFlags({ fireExposures: opts?.fireExposures, context: opts?.context }),
    track: (eventKey: string, payload?: TrackPayload) => host.track(eventKey, payload),
    on: <E extends keyof ClientEventMap>(event: E, cb: ClientEventMap[E]) => host.on(event, cb),
    getDatafile: () => host.datafile(),
    getCurrentContext: () => host.getContext(),
    refresh: () => host.refresh(),
    applyDatafile: (datafile: FlagDatafile) => host.applyDatafileBootstrap(datafile),
    applySnapshot: (snapshot: FlagSnapshot) => host.applySnapshot(snapshot),
  }
  return createUtils(adapter)
}
