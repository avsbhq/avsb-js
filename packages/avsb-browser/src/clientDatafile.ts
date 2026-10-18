// The datafile lifecycle of AvsbClient: readiness, init, refresh, polling,
// streaming, adoption, the SSR handoffs and close. Split out of AvsbClient.ts
// (FU-31); the class keeps the public methods and calls these.

import type { InitResult, FlagDatafile } from '@avsbhq/core'
import { resolveStreamEndpoint } from '@avsbhq/core'
import { createBrowserStreamingClient } from '@avsbhq/utils/streaming'
import type { FlagSnapshot } from '@avsbhq/utils'
import { datafileHttpFailureMessage, datafileUnavailableMessage } from './messages'
import {
  datafileRequestUrl,
  fetchDatafileConditional,
  type DatafileFetchOutcome,
} from './datafileFetch'
import { touchCachedDatafile, writeCachedDatafile } from './datafileCache'
import { acceptDatafile } from './datafileGuard'
import { createPollingLoop } from './polling'
import { AvsbTimeoutError, hostOf } from './net'
import type { ClientState, DatafileSource, RefreshReason } from './clientState'
import { diffAndEmitChanges, notifySubscribers, settleInit } from './clientEvents'
import { ensureTracker, sendHeartbeat } from './clientTracking'

/** The body of `AvsbClient.onReady`. Never rejects. */
export function waitForReady(
  s: ClientState,
  options?: { timeout?: number },
): Promise<InitResult> {
  if (!s.initStarted && s.initResult === null) void initialize(s)

  const timeout = options?.timeout
  if (!timeout || timeout <= 0) return s.readyPromise

  return new Promise<InitResult>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const error = new AvsbTimeoutError(
        hostOf(datafileUrl(s)),
        timeout,
        'waiting for the SDK to become ready',
      )
      s.logger.warn(error.message)
      resolve(
        s.ready
          ? { success: true, degraded: true, source: 'timeout', error }
          : { success: false, source: 'timeout', error },
      )
    }, timeout)

    void s.readyPromise.then((result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    })
  })
}

export async function initialize(s: ClientState): Promise<void> {
  if (s.initStarted || s.closed) return
  s.initStarted = true

  // Yield once before doing anything. The constructor starts init, and
  // without this yield a bootstrapped client would emit 'ready' from
  // inside `new AvsbClient(...)`, before the caller has had a chance to
  // subscribe. One microtask is still "immediately" for anyone awaiting
  // onReady().
  await Promise.resolve()
  if (s.closed) return

  // Bootstrap: the caller already handed us the datafile, so there is
  // nothing to wait for.
  if (s.datafileSource === 'bootstrap') {
    ensureTracker(s)
    settleInit(s, { success: true, source: 'bootstrap' })
    afterReady(s)
    if (s.autoRefresh) startPolling(s)
    return
  }

  const servedFromCache = s.ready

  let outcome: DatafileFetchOutcome | null = null
  let failure: Error | null = null
  try {
    outcome = await fetchDatafile(s)
  } catch (e) {
    failure = e instanceof Error ? e : new Error(String(e))
  }

  if (s.closed) return

  if (outcome?.kind === 'datafile') {
    s.datafileEtag = outcome.etag
    adoptDatafile(s, outcome.datafile, 'network')
    if (s.cacheEnabled) {
      writeCachedDatafile(
        s.sdkKey,
        { datafile: outcome.datafile, etag: outcome.etag },
        s.logger,
      )
    }
    ensureTracker(s)
    settleInit(s, { success: true, source: 'network' })
    afterReady(s)
  } else if (outcome?.kind === 'notModified' && s.ready) {
    // Reachable when a cached datafile was served, since the ETag came
    // from it. The cache is current, so this is a clean success.
    if (s.cacheEnabled) touchCachedDatafile(s.sdkKey, outcome.etag, s.logger)
    ensureTracker(s)
    settleInit(s, { success: true, source: 'network' })
    afterReady(s)
  } else {
    // Everything else is a failed init, including a 304 with nothing to
    // serve (a proxy answering conditionally to a request that carried no
    // ETag). Claiming readiness there would leave the SDK "ready" with no
    // datafile.
    const error = failure ?? httpFailure(s, outcome)
    s.logger.error(error.message)
    s.onError?.(error, 'init')
    s.bus.emit('error', error)

    if (servedFromCache) {
      // `degraded` means exactly this and nothing else (spec §1.2):
      // serving a stale cache after a failed refresh.
      ensureTracker(s)
      settleInit(s, { success: true, degraded: true, source: 'error', error })
      afterReady(s)
    } else {
      // B1: no datafile and no fallback is a FAILED init. This used to
      // resolve `{ success: true, degraded: true }`, which combined with
      // the old noop logger meant a typo'd key produced no signal at all.
      settleInit(s, { success: false, source: 'error', error })
    }
  }

  if (s.autoRefresh) startPolling(s)
}

/** Build the error for a datafile response that carried no datafile. */
function httpFailure(s: ClientState, outcome: DatafileFetchOutcome | null): Error {
  if (outcome?.kind !== 'httpError') {
    return new Error(datafileUnavailableMessage(datafileUrl(s)))
  }
  return new Error(datafileHttpFailureMessage(outcome.status, outcome.url))
}

/** Post-ready side effects: heartbeat, then streaming when enabled. */
function afterReady(s: ClientState): void {
  sendHeartbeat(s)
  if (s.streamingEnabled) initStreamingClient(s)
}

// §8.4 — Initialise the SSE streaming client.
//
// The endpoint is resolved through the core endpoint contract (spec §1.1):
// an explicit option, else the datafile's `streamEndpoint`, else streaming
// stays OFF and says why. The previous derivation string-replaced 'cdn.'
// with 'app.' in cdnHost, which silently produced a wrong host for any
// custom CDN and had no answer at all for a self-hosted deployment.
function initStreamingClient(s: ClientState): void {
  if (s.streamingClient) return

  const resolution = resolveStreamEndpoint({
    optionEndpoint: s.streamingEndpointOption,
    datafileStreamEndpoint: s.datafile?.streamEndpoint ?? null,
  })
  if (!resolution.available) {
    s.logger.warn(resolution.reason)
    return
  }

  s.streamingClient = createBrowserStreamingClient({
    endpoint: resolution.endpoint,
    sdkKey: s.sdkKey,
    logger: s.logger,
    onDatafileUpdated: () => {
      void pollOnce(s, 'stream')
    },
  })

  s.streamingClient.connect()
}

/** The datafile URL this client dials. Built by the endpoint contract. */
function datafileUrl(s: ClientState): string {
  return datafileRequestUrl(s.sdkKey, s.cdnHost)
}

/** One conditional datafile request. See ./datafileFetch. */
function fetchDatafile(s: ClientState): Promise<DatafileFetchOutcome> {
  return fetchDatafileConditional({
    sdkKey: s.sdkKey,
    cdnHost: s.cdnHost,
    etag: s.datafileEtag,
    timeoutMs: s.initTimeoutMs,
  })
}

function startPolling(s: ClientState): void {
  if (s.polling || s.closed) return
  s.polling = createPollingLoop({
    intervalMs: s.pollingIntervalMs,
    jitter: 0.1,
    pauseWhenHidden: s.pauseWhenHidden,
    refetchOnFocus: s.refetchOnFocus,
    logger: s.logger,
    onTick: () => pollOnce(s, 'poll'),
  })
  s.polling.start()
}

/**
 * One datafile refresh. Shared by the polling loop, the SSE push, and the
 * public `refresh()`, so all three apply the result the same way.
 */
export async function pollOnce(s: ClientState, reason: RefreshReason): Promise<void> {
  if (s.closed) return
  const errorSource = reason === 'stream' ? 'stream' : 'poll'
  try {
    const outcome = await fetchDatafile(s)
    if (s.closed) return

    if (outcome.kind === 'notModified') {
      s.datafileEtag = outcome.etag ?? s.datafileEtag
      if (s.cacheEnabled) touchCachedDatafile(s.sdkKey, s.datafileEtag, s.logger)
      s.logger.debug('datafile unchanged', { reason })
      return
    }

    if (outcome.kind === 'httpError') {
      const error = httpFailure(s, outcome)
      s.logger.warn(error.message)
      s.onError?.(error, errorSource)
      return
    }

    s.datafileEtag = outcome.etag
    const changed = adoptDatafile(s, outcome.datafile, reason)
    if (s.cacheEnabled) {
      writeCachedDatafile(
        s.sdkKey,
        { datafile: outcome.datafile, etag: outcome.etag },
        s.logger,
      )
    }
    ensureTracker(s)
    settleInit(s, { success: true, source: 'network' })

    if (changed) {
      s.bus.emit('configUpdate', {
        publishedAt: outcome.datafile.publishedAt,
        reason,
      })
    }
    sendHeartbeat(s)
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    s.logger.warn(err.message)
    s.onError?.(err, errorSource)
  }
}

/**
 * Install a datafile and notify whoever needs to know.
 *
 * Returns false when the datafile is the one already in memory (same
 * `publishedAt`), in which case nothing is rebuilt: that is what keeps
 * snapshots referentially stable between publishes instead of churning on
 * every poll.
 *
 * Named `adoptDatafile`, not `applyDatafile`, on purpose. `applyDatafile` is
 * the one-argument hook name in the `BootstrapTarget` contract that
 * `hydrateBootstrap` calls. A private two-argument method with that name
 * meant a plain-JS caller handing a raw client to the standalone
 * `hydrateBootstrap(client, blob)` would satisfy the structural check and
 * invoke this with `source` undefined.
 */
export function adoptDatafile(s: ClientState, datafile: FlagDatafile, source: DatafileSource): boolean {
  const unchanged =
    s.datafile !== null && s.datafile.publishedAt === datafile.publishedAt
  if (unchanged) {
    s.datafile = datafile
    return false
  }

  const firstDatafile = !s.ready
  s.datafile = datafile
  s.datafileSource = source
  s.ready = true
  // A real datafile supersedes any adopted server snapshot: from here on the
  // client evaluates locally, so context changes and republishes are live.
  s.snapshotBootstrap.release()

  if (firstDatafile) {
    // The ready transition. Diffing from an EMPTY cache is what makes
    // every subscriber fire (report 03 handoff 2): before this,
    // `initialize()` built the flag cache and notified nobody, so a
    // `useSyncExternalStore` consumer that mounted during init kept
    // rendering defaults until some unrelated change woke it.
    diffAndEmitChanges(s, { notifyAllSubscribers: true })
  } else {
    diffAndEmitChanges(s)
  }
  return true
}

/** The body of `AvsbClient.applyDatafileBootstrap`. */
export function applyDatafileBootstrap(s: ClientState, datafile: FlagDatafile): void {
  if (!acceptDatafile(datafile, 'applyDatafileBootstrap', s.logger)) return
  adoptDatafile(s, datafile, 'bootstrap')
  ensureTracker(s)
  settleInit(s, { success: true, source: 'bootstrap' })
}

/** The body of `AvsbClient.applySnapshot`. */
export function applySnapshot(s: ClientState, snap: FlagSnapshot): void {
  if (s.datafile) {
    // A datafile already answers every read, including keys the snapshot
    // never carried and any context change since. Adopting here would be a
    // step backwards, and it is the normal path for a blob carrying both
    // halves: hydrateBootstrap applies the datafile first.
    s.logger.debug(
      'Ignored a bootstrap snapshot: a datafile is already loaded and answers reads.',
    )
    return
  }
  s.snapshotBootstrap.adopt(snap)
  // Values changed under every reader, so drop the memoised flags and wake
  // subscribers exactly as the ready transition does.
  s.snapshots.clear()
  s.allFlagsSnapshot = null
  for (const key of s.flagSubscribers.keys()) notifySubscribers(s, key)
  settleInit(s, { success: true, source: 'bootstrap' })
  s.logger.debug(
    `Adopted a server bootstrap snapshot with ${s.snapshotBootstrap.keys().length} flags; ` +
      'serving its values until a datafile is loaded.',
  )
}

/**
 * The body of `AvsbClient.close`. `drainUtils` is the class's own lazily
 * built utils surface, drained at the same point it always was.
 */
export async function closeClient(s: ClientState, drainUtils: () => void): Promise<void> {
  s.closed = true
  if (s.polling) {
    s.polling.stop()
    s.polling = null
  }
  // §8.4 — disconnect SSE before draining the tracker so no new updates
  // arrive after teardown begins.
  if (s.streamingClient) {
    s.streamingClient.disconnect()
    s.streamingClient = null
  }
  if (s.tracker) {
    await s.tracker.destroy()
    s.tracker = null
  }
  // Nothing forwards after close; a later re-init rebuilds it from whatever
  // datafile is current then.
  s.forwardExposure = null
  drainUtils()
}
