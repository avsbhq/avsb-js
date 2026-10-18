// The datafile lifecycle of AvsbServer: init, readiness, refresh, bootstrap
// handoff, polling, liveness and close. Split out of AvsbServer.ts (FU-31);
// the class keeps the public methods and calls these.

import type { FlagDatafile, InitResult } from '@avsbhq/core'
import { jitteredInterval } from '@avsbhq/utils/backoff'
import { acceptDatafile, fetchDatafile, sendHeartbeat as postHeartbeat } from './datafileSource'
import { raceInitTimeout } from './initTimeout'
import { SDK_TYPE, SDK_VERSION } from './version'
import { emit } from './serverState'
import type { ServerState } from './serverState'
import { initTracker } from './serverTracking'
import { startStreamingIfEnabled } from './serverStreaming'
import type { AvsbServer } from './AvsbServer'

/**
 * Shortest gap between two liveness heartbeats. The dashboard marks an
 * environment Stale at five minutes, so 2 minutes reports comfortably inside
 * that window while a 5s polling interval still costs at most one heartbeat
 * every 24 polls.
 */
const HEARTBEAT_MIN_INTERVAL_MS = 120_000

/** The init attempt behind `AvsbServer.onReady`. Never rejects. */
export async function initializeAndReady(
  s: ServerState,
  server: AvsbServer
): Promise<InitResult> {
  if (s.ready && s.datafile) {
    onDatafileReadable(s, server)
    return { success: true, source: 'bootstrap' }
  }

  try {
    // The timer is cleared when the race settles and is unref'd, so a
    // process that awaited onReady() and close()d exits at once instead
    // of living out initTimeout (N1-6). See ./initTimeout.
    const outcome = await raceInitTimeout(
      // At init there is no stored etag, so 'unchanged' cannot happen here;
      // it is folded in anyway so a future caching layer cannot make init
      // silently report failure.
      loadDatafile(s).then((result) => result !== 'failed'),
      s.initTimeout
    )

    if (outcome.timedOut) {
      startPolling(s, server)
      const error = new Error(
        `AvsB init timed out after ${s.initTimeout}ms waiting for the datafile. ` +
          'Polling continues in the background, so flags start working as soon as ' +
          'the request completes; raise initTimeout if your cold start is slower.'
      )
      emit(s, 'error', error)
      return { success: false, source: 'timeout', error }
    }

    if (outcome.value) {
      onDatafileReadable(s, server)
      return { success: true, source: 'network' }
    }

    startPolling(s, server)
    const error = new Error(
      'AvsB init failed: no datafile could be loaded, so every flag serves the ' +
        'default you passed and flag.source is "not_ready". The datafile request ' +
        'error is logged above with the URL and status. Polling continues.'
    )
    emit(s, 'error', error)
    return { success: false, source: 'error', error }
  } catch (e) {
    startPolling(s, server)
    const error = e instanceof Error ? e : new Error(String(e))
    emit(s, 'error', error)
    return { success: false, source: 'error', error }
  }
}

/** Wiring that runs once a datafile is readable, however it arrived. */
function onDatafileReadable(s: ServerState, server: AvsbServer): void {
  initTracker(s, server)
  s.ready = true
  startPolling(s, server)
  startStreamingIfEnabled(s, () => {
    void loadDatafile(s, 'stream')
  })
  sendHeartbeat(s)
  emit(s, 'ready')
}

/**
 * The body of `AvsbServer.close`. `drainUtils` is the class's own lazily
 * built utils surface, drained at the same point it always was.
 */
export async function closeServer(s: ServerState, drainUtils: () => void): Promise<void> {
  s.destroyed = true
  s.abortController.abort()
  if (s.streamingClient) {
    s.streamingClient.disconnect()
    s.streamingClient = null
  }
  if (s.pollingTimer) {
    clearTimeout(s.pollingTimer)
    s.pollingTimer = null
  }
  if (s.tracker) {
    await s.tracker.destroy()
    s.tracker = null
  }
  drainUtils()
  s.datafile = null
  s.ready = false
}

/** The body of `AvsbServer.refreshDatafile`. */
export async function refreshDatafile(s: ServerState, server: AvsbServer): Promise<void> {
  const result = await loadDatafile(s, 'manual')
  if (result === 'failed') {
    s.logger.warn(
      'AvsB datafile refresh did not apply a new datafile; the SDK keeps serving ' +
        'the one it already has. The request error is logged above.'
    )
    return
  }
  // A manual refresh on a client that never became ready has to finish the
  // readiness transition itself, exactly as the poll loop does. Without
  // this the datafile sat in memory while `isReady()` stayed false, so every
  // flag kept answering "not_ready" and no tracker was ever built.
  if (result === 'applied' && !s.ready) onDatafileReadable(s, server)
}

/** The body of `AvsbServer.applyDatafileBootstrap`. */
export function applyDatafileBootstrap(
  s: ServerState,
  server: AvsbServer,
  datafile: FlagDatafile
): void {
  if (s.destroyed) return
  if (!acceptDatafile(datafile, 'applyDatafileBootstrap', s.logger)) return
  const changed = s.datafile?.publishedAt !== datafile.publishedAt
  s.datafile = datafile
  s.datafileEtag = null
  if (!s.ready) {
    onDatafileReadable(s, server)
    return
  }
  // Already ready: the datafile still just changed, so make sure delivery
  // exists before anything evaluates against it. Idempotent.
  initTracker(s, server)
  if (changed) {
    emit(s, 'configUpdate', {
      publishedAt: datafile.publishedAt,
      reason: 'manual',
    })
  }
}

/**
 * Fetch and apply the datafile.
 *
 * Three outcomes, not two, because a conditional request has three:
 *   'applied'   a datafile came back and is now in memory
 *   'unchanged' the CDN answered 304: what we hold IS current
 *   'failed'    nothing usable came back; the error is already logged
 *
 * 'unchanged' is a success. Collapsing it into 'failed' made
 * `refreshDatafile()` warn that a refresh "did not apply a new datafile"
 * every time the datafile was simply up to date.
 */
async function loadDatafile(
  s: ServerState,
  reason: 'poll' | 'stream' | 'manual' = 'manual'
): Promise<'applied' | 'unchanged' | 'failed'> {
  const outcome = await fetchDatafile({
    sdkKey: s.sdkKey,
    cdnHost: s.cdnHost,
    signal: s.abortController.signal,
    logger: s.logger,
    etag: s.datafileEtag,
  })

  // Liveness rides every SUCCESSFUL refresh, and a 304 is a success: the CDN
  // answered and confirmed what we already hold. This has to run ABOVE the
  // early return, because with conditional requests wired the steady state of
  // an unchanged datafile is a 304 on every poll. Heartbeating only on 200
  // would mean one beat at boot and then Stale forever on a healthy process.
  // The 120s throttle inside sendHeartbeat bounds the traffic either way.
  if (outcome.status === 'ok' || outcome.status === 'not-modified') {
    sendHeartbeat(s)
  }

  if (outcome.status === 'not-modified') return 'unchanged'
  if (outcome.status !== 'ok') return 'failed'

  const changed =
    !s.datafile || s.datafile.publishedAt !== outcome.datafile.publishedAt
  s.datafile = outcome.datafile
  s.datafileEtag = outcome.etag

  if (s.ready && changed) {
    emit(s, 'configUpdate', {
      publishedAt: outcome.datafile.publishedAt,
      reason,
    })
    s.logger.info('Datafile updated', {
      publishedAt: outcome.datafile.publishedAt,
      reason,
    })
    // The stream endpoint is a datafile field, so a republish can turn
    // streaming on for a process that started without it.
    startStreamingIfEnabled(s, () => {
      void loadDatafile(s, 'stream')
    })
  }
  return 'applied'
}

/**
 * Poll on a JITTERED interval. Without the jitter every process that
 * deployed together polls the CDN on the same tick forever.
 */
function startPolling(s: ServerState, server: AvsbServer): void {
  if (s.pollingTimer || s.destroyed) return
  const schedule = (): void => {
    s.pollingTimer = setTimeout(() => {
      s.pollingTimer = null
      void (async () => {
        const result = await loadDatafile(s, 'poll')
        if (result === 'applied' && !s.ready) onDatafileReadable(s, server)
        if (!s.destroyed) schedule()
      })()
    }, jitteredInterval(s.pollingInterval))
  }
  schedule()
}

/**
 * Report liveness, throttled.
 *
 * Called on every successful datafile load, not just at init: the dashboard
 * marks an environment Stale after five minutes without a heartbeat, so an
 * init-only heartbeat made every long-running process look dead a few
 * minutes after it started. The throttle keeps a fast polling interval (or a
 * burst of stream-triggered refreshes) from turning liveness into traffic.
 *
 * Fire and forget: a failed heartbeat never affects evaluation, and the
 * throttle clock is stamped by the synchronous send below, so a hanging
 * request cannot queue a second one.
 */
function sendHeartbeat(s: ServerState): void {
  const now = Date.now()
  if (now - s.lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) return
  const posted = postHeartbeat({
    sdkKey: s.sdkKey,
    sdkType: SDK_TYPE,
    sdkVersion: SDK_VERSION,
    datafileHeartbeatEndpoint: s.datafile?.heartbeatEndpoint,
    signal: s.abortController.signal,
  })
  // ONLY a posted heartbeat opens the throttle window. `loadDatafile` beats
  // before it applies the datafile it just fetched, so on the very first
  // network load there is no endpoint to post to yet; stamping the clock there
  // silenced the real beat that `onDatafileReadable` fires a moment later, and
  // every CDN-loaded process then reported no liveness at all and went Stale
  // on the Environments page five minutes after boot. The send is synchronous
  // (fire and forget inside), so stamping after it still cannot queue a second.
  if (posted) s.lastHeartbeatAt = now
}
