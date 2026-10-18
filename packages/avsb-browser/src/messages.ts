// =====================================================================
// Every customer-facing string AvsbClient emits, in one file (spec §1.2).
//
// The loudness contract says each message names three things: WHAT failed,
// the EXACT value involved (the flag key, the HTTP status, the URL tried,
// the cap that was hit), and WHERE the fix is (a dashboard path or the
// call to change). Keeping them together is what makes that auditable:
// one file to read when checking that the SDK never fails silently and
// never says something a developer cannot act on.
//
// Sibling modules keep their own strings (tracker, polling, identity,
// sdkKeyShape) because those are local to one mechanism and read better
// next to the code that decides to emit them.
//
// Style: no em-dash anywhere, plain sentences, no jargon a first-week user
// would not know.
// =====================================================================

/** The reason string carried on every pre-ready read (`flag.reasons`). */
export const NOT_READY_REASON =
  'sdk not ready: the datafile has not been loaded yet'

/** Logged once per flag key, so a render loop cannot flood the console. */
export function notReadyReadMessage(flagKey: string): string {
  return (
    `AvsB read flag "${flagKey}" before the SDK finished loading its datafile, ` +
    'so it returned the default value you passed and reported source "not_ready". ' +
    'Await client.onReady() (or render from the ready state) before reading flags, ' +
    'or pass a bootstrap datafile so the very first read is real.'
  )
}

/** An empty flag map is indistinguishable from a project with no flags. */
export function allFlagsNotReadyMessage(): string {
  return (
    'AvsB getAllFlags() ran before the SDK finished loading its datafile, so it ' +
    'returned an empty map rather than your flags. Await client.onReady() first, ' +
    'or pass a bootstrap datafile.'
  )
}

export function trackAfterCloseMessage(eventKey: string): string {
  return (
    `AvsB dropped the "${eventKey}" event because close() has already run. ` +
    'Track before closing the client, or build a new client if the page is still alive.'
  )
}

export function pendingQueueFullMessage(cap: number, dropped: number): string {
  return (
    `AvsB is holding ${cap} events waiting for the SDK to become ready and has ` +
    `started dropping the oldest (${dropped} so far). That means the datafile never ` +
    'loaded: check the SDK key and the browser network tab. Raise maxPendingEvents ' +
    'if a slow first load is expected.'
  )
}

export function typedGetterMismatchMessage(
  flagKey: string,
  variant: string,
  typeError: string,
): string {
  return (
    `AvsB ${flagKey} was read with the ${variant} getter but the flag is not a ` +
    `${variant} flag (${typeError}), so the default was returned. Use the getter ` +
    'that matches the flag type in the A vs B dashboard, or getFlag for a dynamic type.'
  )
}

/** Non-2xx on a datafile request. 404 gets the "wrong key" walkthrough. */
export function datafileHttpFailureMessage(status: number, url: string): string {
  const explanation =
    status === 404
      ? 'That means this SDK key does not exist: it is a typo, a key from a deleted ' +
        'environment, or a key from another project. Copy it again from ' +
        'app.avsb.cloud, then Environments in the project sidebar. '
      : 'The CDN could not serve the datafile. '
  return (
    `AvsB datafile request returned HTTP ${status} for ${url}. ${explanation}` +
    'Every flag returns the default value you passed until this is fixed.'
  )
}

/** Fallback for a failed init with no status to report. */
export function datafileUnavailableMessage(url: string): string {
  return (
    `AvsB could not load the datafile from ${url} and no bootstrap or cached copy ` +
    'was available, so every flag returns the default value you passed.'
  )
}
