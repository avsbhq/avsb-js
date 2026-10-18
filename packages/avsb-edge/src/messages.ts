// =====================================================================
// Every customer-facing string the edge client emits, in one file
// (spec §1.2, mirroring packages/avsb-browser/src/messages.ts).
//
// The loudness contract: each message names WHAT failed, the EXACT value
// involved (the flag key, the HTTP status, the URL tried, the cap that was
// hit), and WHERE the fix is (a dashboard path, or the call to change).
// One file makes that auditable.
//
// Sibling modules keep their own strings (sdkKeyShape, net) because those
// are local to one mechanism and read better next to the code that decides
// to emit them.
//
// Style: no em-dash, plain sentences, no jargon a first-week user would
// not know.
// =====================================================================

/** The reason string carried on every pre-init read (`flag.reasons`). */
export const NOT_READY_REASON =
  'sdk not ready: init() has not completed, so no datafile is loaded'

/** Logged once per flag key per isolate, so a hot Worker cannot flood. */
export function notReadyReadMessage(flagKey: string): string {
  return (
    `AvsB read flag "${flagKey}" before init() finished, so it returned the ` +
    'default value you passed and reported source "not_ready". Await ' +
    'client.init() before reading flags. If you build the client yourself, ' +
    'await it once per request; if you use an adapter from @avsbhq/edge/*, ' +
    'the adapter already awaits it for you and this means the client was ' +
    'constructed somewhere else.'
  )
}

/** An empty flag map is indistinguishable from a project with no flags. */
export function allFlagsNotReadyMessage(): string {
  return (
    'AvsB getAllFlags() ran before init() finished, so it returned an empty ' +
    'map rather than your flags. Await client.init() first, or pass a ' +
    'bootstrap datafile.'
  )
}

/**
 * No identity anywhere in the request. Every visitor buckets identically,
 * which quietly turns an experiment into a 100% rollout of one variation.
 * This is the empty-context warning spec §1.2 requires.
 */
export function emptyContextMessage(): string {
  return (
    'AvsB evaluated a flag with no visitor identity, so every request buckets ' +
    'into the same variation and any A/B rule effectively serves one side to ' +
    'everyone. The request carried neither an "x-avsb-visitor-id" header nor ' +
    'an "_avsb_visitor" cookie, and no contextFrom option was passed. Pass ' +
    'contextFrom to the adapter (or a context option to AvsbEdgeClient) that ' +
    'returns { kind: "user", key: yourStableId }. If the A vs B snippet also ' +
    'runs on this site, forward its "_avsb_visitor" cookie and both surfaces ' +
    'will report the same visitor.'
  )
}

/** A typed getter was used against a flag the datafile declares differently. */
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

/** Non-2xx on a datafile request. 404 gets the wrong-key walkthrough. */
export function datafileHttpFailureMessage(status: number, url: string): string {
  const explanation =
    status === 404
      ? 'That means this SDK key does not exist: it is a typo, a key from a ' +
        'deleted environment, or a key from another project. Copy it again ' +
        'from app.avsb.cloud, then Environments in the project sidebar. '
      : 'The CDN could not serve the datafile. '
  return (
    `AvsB datafile request returned HTTP ${status} for ${url}. ${explanation}` +
    'Every flag returns the default value you passed until this is fixed.'
  )
}

/** Failed init with no status to report and nothing cached to fall back on. */
export function datafileUnavailableMessage(url: string): string {
  return (
    `AvsB could not load the datafile from ${url} and no bootstrap or cached ` +
    'copy was available, so every flag returns the default value you passed. ' +
    'Check that the runtime is allowed to make outbound requests to that host.'
  )
}

/** A refresh failed but a cached copy is still usable: the degraded state. */
export function servingStaleCacheMessage(url: string, ageMs: number): string {
  const ageSeconds = Math.round(ageMs / 1000)
  return (
    `AvsB could not refresh the datafile from ${url}, so it is serving the ` +
    `cached copy from ${ageSeconds}s ago. Flags still evaluate, but a change ` +
    'published in the dashboard since then is not visible yet. init() ' +
    'reported degraded: true for this request.'
  )
}

/** A bootstrap datafile was handed in for a different environment key. */
export function bootstrapKeyMismatchMessage(
  optionKey: string,
  datafileKey: string,
): string {
  return (
    `AvsB was constructed with sdkKey "${optionKey}" but the bootstrap ` +
    `datafile was published for "${datafileKey}". Flags will evaluate against ` +
    'the bootstrap, and events will be attributed to the sdkKey you passed, ' +
    'so results land under the wrong environment. Pass the datafile that ' +
    'matches the key, or drop the sdkKey mismatch.'
  )
}

/** A whole batch could not be delivered. Names endpoint, status, and count. */
export function eventSendFailureMessage(
  count: number,
  label: string,
  endpoint: string,
  attempts: number,
  detail: string,
): string {
  return (
    `AvsB could not send ${count} ${label} to ${endpoint} after ${attempts} ` +
    `attempt${attempts === 1 ? '' : 's'} (${detail}). Edge runtimes end with ` +
    'the request, so these events are lost rather than retried later. Check ' +
    'that the runtime allows outbound requests to that host.'
  )
}

/** The queue filled inside one request, which means an unbounded loop. */
export function eventQueueFullMessage(cap: number, label: string): string {
  return (
    `AvsB dropped the oldest ${label} because one request queued more than ` +
    `${cap} of them. An edge client lives for a single request, so hitting ` +
    'this cap means events are being queued in a loop. Raise maxQueueSize if ' +
    'a request really does produce that many.'
  )
}

/**
 * `properties` on a tracked event never reaches storage. The metric batch
 * body has no properties field (wire fixture `metric_batch`), so the
 * ingestion worker strips it: it would look delivered and be gone.
 *
 * Delete this message when the metric wire contract gains a home for
 * properties; until then saying nothing would be the silent drop the
 * loudness contract bans.
 */
export function trackPropertiesDroppedMessage(eventKey: string): string {
  return (
    `AvsB received properties on the tracked event "${eventKey}", but tracked ` +
    'events are stored without them, so they will not be queryable in results. ' +
    'Put money in `revenue` or a number in `value` instead: both are stored ' +
    'and reportable. Exposure ' +
    'events do carry properties; tracked events do not.'
  )
}

/**
 * A datafile the evaluator cannot read (N0-15), refused where it entered:
 * the `datafile` option, a fetched body, or a cached copy. `problem` comes
 * from core's `datafileShapeProblem` and names the broken field.
 */
export function malformedDatafileMessage(
  origin: 'option' | 'network' | 'cache',
  problem: string,
  url: string,
): string {
  if (origin === 'option') {
    return (
      `AvsB ignored the datafile passed to new AvsbEdgeClient(): ${problem}. ` +
      `init() loads it from ${url} instead, and reads return the default you ` +
      'passed (source "not_ready") until it arrives. Pass the datafile JSON ' +
      'exactly as the CDN serves it for this SDK key.'
    )
  }
  if (origin === 'cache') {
    return (
      `AvsB discarded the cached datafile for ${url}: ${problem}. It is ` +
      'fetched again from the CDN; check what writes to the datafile cache if ' +
      'this repeats.'
    )
  }
  return (
    `AvsB got a response from ${url} that is not a datafile the SDK can read: ` +
    `${problem}. That usually means a proxy or a platform interstitial ` +
    'answered instead of the CDN. Request that URL directly to see what came ' +
    'back. The SDK keeps the datafile it already has, if any.'
  )
}
