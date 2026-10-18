// =====================================================================
// Provider status derivation (report 03 §5 cluster A, §7 item 2).
//
// THE BUG THIS EXISTS TO KILL: the provider used to set `status: 'ready'`
// from `onReady()` resolving, whatever the result said. A wrong SDK key
// resolved (it never rejects), the 'error' bus event that fired first was
// then overwritten by the later 'ready' set, and the app rendered
// defaults forever with no signal at all.
//
// The rules, in one pure function so they can be tested without a React
// tree:
//
//   1. `status: 'ready'` means FLAGS ARE READABLE NOW. A bootstrap
//      datafile, a cached datafile from a previous visit, or a completed
//      fetch all qualify, which is exactly what `client.isReady()`
//      answers.
//   2. A DEGRADED init is ready-with-warning, never fatal. Serving a
//      stale cached datafile after a failed refresh means flags work, so
//      status stays 'ready', `degraded` is true, and the error is carried
//      alongside for a UI that wants to say so. The browser client emits
//      an 'error' EVENT for that case AND resolves
//      `{success: true, degraded: true}`; treating that event as fatal is
//      the trap this module documents away.
//   3. `status: 'error'` means the init attempt settled with nothing to
//      serve (`{success: false}`, spec §1.2 / B1). That is the only fatal
//      state, and the message names the status, the URL, and the fix
//      because the client built it that way.
//   4. Anything else is 'loading'. An error seen while still loading is
//      carried but not fatal: a later poll can still rescue the client,
//      and it does (`settleInit` re-settles a failed init).
// =====================================================================

import type { InitResult } from '@avsbhq/core'

/**
 * Lifecycle of the provider's client.
 *
 * - `'loading'`: nothing is readable yet. The first datafile is in flight.
 * - `'ready'`: flag reads answer with real values. May be `degraded`.
 * - `'error'`: the init attempt finished with nothing to serve. Every
 *   read returns the default you passed.
 */
export type AvsbStatus = 'loading' | 'ready' | 'error'

/** What `useAvsbStatus()` returns. */
export interface AvsbStatusState {
  status: AvsbStatus
  /**
   * The failure behind `'error'`, or the refresh failure behind a
   * degraded `'ready'`. Its message names what failed, the exact URL or
   * status involved, and where to fix it.
   */
  error?: Error
  /**
   * Flags are readable but may be stale: a cached or bootstrapped
   * datafile is being served because a refresh failed. Polling continues,
   * so this can clear on its own.
   */
  degraded: boolean
}

export interface DeriveStatusInput {
  /** `client.isReady()`: are flags readable right now? */
  readable: boolean
  /** `client.getInitResult()`: the settled outcome, or null while in flight. */
  initResult: InitResult | null
  /** The most recent 'error' event that has not been cleared by a successful refresh. */
  lastError?: Error
}

/**
 * Map the client's readable/settled/error triple onto the three states a
 * provider exposes. Pure, total, and the single place these rules live.
 */
export function deriveStatus(input: DeriveStatusInput): AvsbStatusState {
  const { readable, initResult, lastError } = input

  if (readable) {
    // Rule 2. `degraded` is true when the client said so, and also when a
    // refresh has failed since (the client only settles once, so a poll
    // failure after a healthy init never shows up in `initResult`).
    const degraded = initResult?.degraded === true || lastError !== undefined
    return {
      status: 'ready',
      degraded,
      error: degraded ? (initResult?.error ?? lastError) : undefined,
    }
  }

  if (initResult && !initResult.success) {
    // Rule 3.
    return {
      status: 'error',
      degraded: false,
      error: initResult.error ?? lastError,
    }
  }

  // Rule 4.
  return { status: 'loading', degraded: false, error: lastError }
}

/** Two status states are equal when a re-render would show the same thing. */
export function sameStatus(a: AvsbStatusState, b: AvsbStatusState): boolean {
  return a.status === b.status && a.degraded === b.degraded && a.error === b.error
}
