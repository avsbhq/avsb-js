/**
 * `avsb codegen --watch`: keep the generated files matching the platform while
 * you work.
 *
 * The loop is bounded polling of the datafile endpoint, not a file watcher and
 * not a stream. Flags change in a browser tab, not on your disk, so there is
 * nothing local to watch; and the datafile is served through a CDN with a
 * 60-second cache, so a socket would buy nothing a poll does not already give.
 * Each poll sends the previous ETag, so an unchanged datafile costs a 304 the
 * moment the route starts sending one.
 *
 * Everything that touches the world is injected, so the loop is tested with no
 * network, no filesystem, and no real timers.
 */

export const DEFAULT_WATCH_INTERVAL_MS = 10_000
export const MIN_WATCH_INTERVAL_MS = 2_000
export const MAX_WATCH_INTERVAL_MS = 300_000
/** Consecutive failed polls before the loop gives up rather than spinning. */
export const MAX_WATCH_FAILURES = 5

export type WatchEvent =
  | { kind: 'polled'; changed: false; notModified: boolean }
  | { kind: 'polled'; changed: true; notModified: false; written: string[] }
  | { kind: 'failed'; message: string; attempt: number; retryInMs: number }
  | { kind: 'stopped' }

export interface WatchDeps<TDatafile> {
  /** One conditional read. Rejects on a real failure; 304 is not a failure. */
  fetchDatafile: (etag: string | null) => Promise<
    { status: 'not-modified'; etag: string | null } | { status: 'ok'; datafile: TDatafile; etag: string | null }
  >
  /**
   * Write whatever the datafile now produces, and report which files actually
   * changed on disk. An empty array means the platform answered with a new
   * datafile that generates identical output (a rule edit, a renamed
   * environment) and nothing needed rewriting.
   */
  writeOutputs: (datafile: TDatafile) => Promise<string[]>
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  onEvent: (event: WatchEvent) => void
  signal: AbortSignal
  intervalMs: number
  /** The ETag from the initial generation, when there was one. */
  initialEtag?: string | null
  maxFailures?: number
}

export interface WatchSummary {
  polls: number
  regenerations: number
  failures: number
  /** True when the loop ended because it ran out of retries, not because you did. */
  gaveUp: boolean
  lastError: string | null
}

/**
 * How long to wait after a failed poll: the interval, then doubling, capped at
 * a minute. A laptop that closes its lid during a two-hour session should not
 * come back to a thousand queued retries, and a platform having a bad five
 * minutes should not be hammered.
 */
export function nextWatchBackoffMs(intervalMs: number, consecutiveFailures: number): number {
  const grown = intervalMs * 2 ** Math.max(0, consecutiveFailures - 1)
  return Math.min(grown, 60_000)
}

/**
 * Validate `--interval`. Returns the millisecond value, or a reason the value
 * is refused: a 200ms poll against a CDN-cached file is a way to get rate
 * limited, not a way to see changes sooner.
 */
export function parseWatchInterval(raw: string | undefined): { ms: number } | { error: string } {
  if (raw === undefined) return { ms: DEFAULT_WATCH_INTERVAL_MS }

  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { error: `Invalid --interval value "${raw}". Pass a number of seconds, for example 10.` }
  }

  const ms = Math.round(seconds * 1000)
  if (ms < MIN_WATCH_INTERVAL_MS) {
    return {
      error: `--interval must be at least ${MIN_WATCH_INTERVAL_MS / 1000} seconds. The datafile is cached for 60 seconds, so polling faster shows you nothing new.`,
    }
  }
  if (ms > MAX_WATCH_INTERVAL_MS) {
    return { error: `--interval must be at most ${MAX_WATCH_INTERVAL_MS / 1000} seconds.` }
  }
  return { ms }
}

/**
 * Poll until the caller aborts (Ctrl+C) or the platform keeps refusing.
 *
 * Never throws: a failure is reported through `onEvent` and retried, and the
 * summary says what happened. A watch command that dies on one flaky request
 * is a watch command people stop trusting.
 */
export async function runWatchLoop<TDatafile>(deps: WatchDeps<TDatafile>): Promise<WatchSummary> {
  const maxFailures = deps.maxFailures ?? MAX_WATCH_FAILURES
  const summary: WatchSummary = {
    polls: 0,
    regenerations: 0,
    failures: 0,
    gaveUp: false,
    lastError: null,
  }

  let etag = deps.initialEtag ?? null
  let consecutiveFailures = 0

  while (!deps.signal.aborted) {
    await deps.sleep(
      consecutiveFailures > 0
        ? nextWatchBackoffMs(deps.intervalMs, consecutiveFailures)
        : deps.intervalMs,
      deps.signal,
    )
    if (deps.signal.aborted) break

    summary.polls += 1

    try {
      const result = await deps.fetchDatafile(etag)
      consecutiveFailures = 0

      if (result.status === 'not-modified') {
        // Nothing was written, so nothing can be stale: keeping the new ETag is
        // always right on this path.
        etag = result.etag
        deps.onEvent({ kind: 'polled', changed: false, notModified: true })
        continue
      }

      const written = await deps.writeOutputs(result.datafile)

      // Only NOW is the ETag safe to remember. Committing it before the write
      // means a write that failed (read-only checkout, full disk) leaves the
      // files stale while every later poll answers 304, so the loop would never
      // try again and would never say so.
      etag = result.etag

      if (written.length === 0) {
        deps.onEvent({ kind: 'polled', changed: false, notModified: false })
      } else {
        summary.regenerations += 1
        deps.onEvent({ kind: 'polled', changed: true, notModified: false, written })
      }
    } catch (err) {
      summary.failures += 1
      consecutiveFailures += 1
      summary.lastError = err instanceof Error ? err.message : 'the poll failed'

      if (consecutiveFailures >= maxFailures) {
        summary.gaveUp = true
        break
      }

      deps.onEvent({
        kind: 'failed',
        message: summary.lastError,
        attempt: consecutiveFailures,
        retryInMs: nextWatchBackoffMs(deps.intervalMs, consecutiveFailures),
      })
    }
  }

  if (!summary.gaveUp) deps.onEvent({ kind: 'stopped' })
  return summary
}
