/**
 * Waiting for the first check-in, and being honest when it does not come.
 *
 * Every SDK posts to `/api/sdk/heartbeat` after a successful datafile fetch,
 * and the platform stamps `FlagEnvironment.lastSdkSeenAt`. Reading that stamp is
 * how the dashboard proves an install, and it is how `avsb init` proves one from
 * a terminal: run your app, and the CLI sees it.
 *
 * Three properties, all deliberate:
 *
 *   - BOUNDED. A fixed window, then it stops and says what it saw. It never
 *     waits forever and never claims success it did not observe.
 *   - FRESH ONLY. An environment that checked in last week, or a minute ago
 *     from an app that has since stopped, is not proof that THIS setup works.
 *     A stamp counts when it moved during the wait (a check-in happened while
 *     we watched, whatever the clocks say), or when it is no older than the
 *     wait itself, give or take a few seconds of clock difference (QA N4-12:
 *     a one-minute allowance passed a 40-second-old check-in with no app
 *     running).
 *   - TIMEOUT IS NOT A LIE. When nothing arrives the guidance names the four
 *     things that are actually wrong in practice, most likely first: nothing in
 *     the environment is turned on yet (a new environment has no configuration
 *     for the SDK to load, and the SDK checks in only after loading one), the
 *     app never started, the key in the code is a different one, or outbound
 *     requests are blocked.
 *
 * The loop mirrors `smoke/src/http.ts`'s `poll`: attempt, note, sleep, deadline.
 * The clock and the sleep are injected, so every branch is tested with no timers
 * and no network.
 */

export const HEARTBEAT_INTERVAL_MS = 3000
export const HEARTBEAT_TIMEOUT_MS = 120_000

/**
 * How far the platform's clock may sit behind the local one before a genuine
 * check-in would be dismissed as stale. Clocks kept by NTP agree to well under
 * a second; five seconds covers that plus the first read's round trip. It used
 * to be a minute, which accepted a check-in from an app that had already
 * stopped. A check-in that arrives while we watch counts whatever the clocks
 * say (see `isNewerThan`), so a skewed clock cannot hide a real one.
 */
export const CLOCK_ALLOWANCE_MS = 5_000

export interface HeartbeatSample {
  lastSdkSeenAt: string | null
  lastSdkType: string | null
  lastSdkVersion: string | null
}

export type HeartbeatOutcome =
  | {
      seen: true
      at: string
      sdkType: string | null
      sdkVersion: string | null
      elapsedMs: number
    }
  | {
      seen: false
      elapsedMs: number
      /** The stamp that was already there when the wait began, if any. */
      previousSeenAt: string | null
    }

export interface HeartbeatWaitOptions {
  /** One read of the environment row. */
  probe: () => Promise<HeartbeatSample>
  /** Epoch milliseconds the run started (local clock). */
  startedAt: number
  timeoutMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Called after each miss, so the CLI can keep a spinner honest. */
  onAttempt?: (elapsedMs: number) => void
}

/**
 * True when this stamp is new enough to have come from the run in progress.
 *
 * An unparseable stamp is treated as not fresh: a check-in we cannot date is
 * not proof of anything.
 */
export function isFreshHeartbeat(
  lastSdkSeenAt: string | null,
  startedAt: number,
  allowanceMs: number = CLOCK_ALLOWANCE_MS,
): boolean {
  if (!lastSdkSeenAt) return false
  const seenAt = Date.parse(lastSdkSeenAt)
  if (Number.isNaN(seenAt)) return false
  return seenAt >= startedAt - allowanceMs
}

/** True when `stamp` is a later check-in than `previous`. Unparseable stamps never are. */
export function isNewerThan(stamp: string | null, previous: string | null): boolean {
  if (!stamp || !previous) return false
  const seenAt = Date.parse(stamp)
  const before = Date.parse(previous)
  return !Number.isNaN(seenAt) && !Number.isNaN(before) && seenAt > before
}

/** Poll until a fresh check-in arrives or the window closes. Never throws. */
export async function waitForHeartbeat(options: HeartbeatWaitOptions): Promise<HeartbeatOutcome> {
  const timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const begunAt = now()

  let previousSeenAt: string | null = null
  let first = true

  for (;;) {
    let sample: HeartbeatSample
    try {
      sample = await options.probe()
    } catch {
      // A failed read is a missed tick, not a failed setup: the app may well be
      // starting while the network hiccups. The deadline still applies.
      sample = { lastSdkSeenAt: null, lastSdkType: null, lastSdkVersion: null }
    }

    if (first) {
      previousSeenAt = sample.lastSdkSeenAt
      first = false
    }

    const arrivedWhileWatching = isNewerThan(sample.lastSdkSeenAt, previousSeenAt)
    if (
      sample.lastSdkSeenAt &&
      (arrivedWhileWatching || isFreshHeartbeat(sample.lastSdkSeenAt, options.startedAt))
    ) {
      return {
        seen: true,
        at: sample.lastSdkSeenAt,
        sdkType: sample.lastSdkType,
        sdkVersion: sample.lastSdkVersion,
        elapsedMs: now() - begunAt,
      }
    }

    const elapsed = now() - begunAt
    options.onAttempt?.(elapsed)

    if (elapsed + intervalMs >= timeoutMs) {
      return { seen: false, elapsedMs: elapsed, previousSeenAt }
    }

    await sleep(intervalMs)
  }
}

export interface TimeoutGuidanceInput {
  sdkKey: string
  environmentName: string
  /** The environment's key, for the `flags toggle` line. Defaults to `production`. */
  environmentKey?: string
  /** The flag the example reads, or null when the project has none yet. */
  flagKey?: string | null
  previousSeenAt: string | null
  waitedMs: number
  /** Hosts an SDK must be able to reach, for the firewall line. */
  cdnHost: string
  appHost: string
}

/**
 * What to print when the window closes. Four checks, in the order they are
 * usually wrong, plus the fact that nothing here is destructive: the setup is
 * done, only the proof is missing.
 *
 * Turning a flag on comes first (QA N4-9): on a brand-new project it is the
 * usual cause, and it was the one cause the old text left out.
 */
export function heartbeatTimeoutGuidance(input: TimeoutGuidanceInput): string[] {
  const seconds = Math.round(input.waitedMs / 1000)
  const lines = [
    `No check-in from ${input.environmentName} in ${seconds}s. Everything above is written; only the proof is missing.`,
    `${turnFlagOnCommand(input.flagKey ?? null, input.environmentKey ?? 'production')} An environment where nothing has been turned on has no configuration for the SDK to load, and the SDK checks in only after it loads one.`,
    'Start your app once, then run `avsb init --wait 120` again to watch for it.',
    `Check that the key your code loads is ${input.sdkKey}.`,
    `Check that outbound requests to ${input.cdnHost} and ${input.appHost} are allowed.`,
  ]

  if (input.previousSeenAt) {
    lines.push(
      `This environment did check in earlier, at ${input.previousSeenAt}, so the key itself works.`,
    )
  }

  return lines
}

/** The first thing to try: turn the flag on, named when it is known. */
export function turnFlagOnCommand(flagKey: string | null, environmentKey: string): string {
  return `Turn a flag on with \`avsb flags toggle ${flagKey ?? '<key>'} --env ${environmentKey} --on\`.`
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
