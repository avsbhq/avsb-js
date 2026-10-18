// =====================================================================
// The init timeout race (N1-6, production QA 2026-10-01).
//
// `onReady()` races the first datafile request against `initTimeout`. The
// timer used to be created inline and never cleared, so when the datafile
// won (the normal case) the timer stayed armed: a script that awaited
// `onReady()` and then `close()` kept running for the full `initTimeout`
// (10 seconds by default) before Node could exit. Serverless handlers that
// wait for an empty event loop, and test runners, saw the same hang.
//
// Two rules fix it, and both live here so they are testable:
//   1. The timer is cleared the moment the race settles, whichever side won.
//   2. The timer is unref'd. It only bounds how long `onReady()` WAITS; the
//      datafile request keeps the process alive while it is in flight, so
//      the timer itself must never be the reason a process stays up.
// =====================================================================

export type InitRaceOutcome<T> = { timedOut: false; value: T } | { timedOut: true }

/**
 * Settle with `work`'s value, or with `{ timedOut: true }` after `timeoutMs`,
 * whichever comes first. A rejection of `work` propagates. The timer never
 * outlives the race and never holds the process open.
 */
export async function raceInitTimeout<T>(
  work: Promise<T>,
  timeoutMs: number
): Promise<InitRaceOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<InitRaceOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
    // `unref` exists on Node timers; guarded for runtimes whose timers are
    // plain numbers.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref()
  })
  try {
    return await Promise.race([
      work.then((value): InitRaceOutcome<T> => ({ timedOut: false, value })),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}
