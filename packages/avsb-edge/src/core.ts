// =====================================================================
// @avsbhq/edge shared internals: datafile transport and the evaluation
// wrapper. No global state, no setInterval, no EventSource.
//
// THE TWO BUGS THIS FILE EXISTED TO CAUSE (report 02 §5.1, §5.2):
//
//   1. The datafile URL was `${cdnHost}/datafiles/${sdkKey}.json`. The
//      platform contract is `${cdnHost}/${sdkKey}/datafile.json`, which is
//      what the browser, the SSR helper, node, and the CDN worker all use.
//      Every un-customised edge install 404'd, `init()` left `datafile`
//      null, and every flag silently served its default forever. The URL is
//      now built by `datafileUrl` from @avsbhq/core, the single source of
//      truth for data-plane targets (spec §1.1), so the shape cannot drift
//      again without the endpoints fixture failing.
//
//   2. `evaluateFlagEdge` passed `undefined` for the evaluator's
//      `onExposure` hook, so a flag with an ab_test rule produced a
//      variation and zero exposure data. Edge experimentation looked wired
//      and measured nothing. The hook is now a required-by-convention
//      parameter the client always supplies.
//
// A third, quieter bug: a missing datafile returned `notFoundFlag`, which
// means "the datafile loaded and this key is not in it". It now returns
// `notReadyFlag` (breaking change B15) so "the SDK never loaded" and "you
// asked for a flag that does not exist" stop looking identical.
// =====================================================================

import { DEFAULT_CDN_HOST, datafileUrl } from '@avsbhq/core'
import type {
  EvalContext,
  ExposureEvent,
  Flag,
  FlagDatafile,
} from '@avsbhq/core'
import { createFlag, mapLegacySource, notReadyFlag } from '@avsbhq/core'
import { evaluateFlag } from '@avsbhq/core/engine'
import { fetchWithTimeout, headerOf, hostOf } from './net'
import { NOT_READY_REASON } from './messages'

/** Default budget for one datafile request. */
export const DEFAULT_DATAFILE_TIMEOUT_MS = 3_000

/**
 * The URL a given key resolves to. Exported so every log line and error
 * message can name the exact address that was tried.
 */
export function datafileRequestUrl(sdkKey: string, cdnHost: string = DEFAULT_CDN_HOST): string {
  try {
    return datafileUrl(sdkKey, cdnHost)
  } catch {
    // `datafileUrl` throws only for an empty key, which the key-shape check
    // has already reported. Keep a printable value for messages.
    return `${cdnHost.replace(/\/+$/, '')}/${sdkKey}/datafile.json`
  }
}

/** What one datafile request produced. */
export type DatafileFetchOutcome =
  | { kind: 'datafile'; datafile: FlagDatafile; etag: string | null; url: string }
  | { kind: 'httpError'; status: number; url: string }
  | { kind: 'transportError'; error: Error; url: string }

export interface FetchDatafileOptions {
  cdnHost?: string
  /** Ms budget for the request. Default 3000. */
  timeoutMs?: number
  /** Sent as `If-None-Match` when present. */
  etag?: string | null
}

/**
 * Fetch a datafile from the A vs B CDN.
 *
 * Returns a STRUCTURED outcome rather than `FlagDatafile | null`. The old
 * signature collapsed "the key does not exist", "the CDN is down", and "a
 * proxy answered with an HTML error page" into one `null`, which is why the
 * package could be broken for a year without a single log line. The caller
 * needs the status and the URL to say anything useful.
 *
 * Datafile reads are KEYLESS BY PATH (spec §1.1): the key is the path
 * segment. No Authorization header, no key header, no query string.
 */
export async function fetchDatafileFromCdn(
  sdkKey: string,
  options: FetchDatafileOptions = {},
): Promise<DatafileFetchOutcome> {
  const url = datafileRequestUrl(sdkKey, options.cdnHost ?? DEFAULT_CDN_HOST)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.etag) headers['If-None-Match'] = options.etag

  let response: Response
  try {
    response = await fetchWithTimeout(url, {
      timeoutMs: options.timeoutMs ?? DEFAULT_DATAFILE_TIMEOUT_MS,
      what: 'loading the datafile',
      init: { method: 'GET', headers },
    })
  } catch (e) {
    return {
      kind: 'transportError',
      error: e instanceof Error ? e : new Error(String(e)),
      url,
    }
  }

  if (!response.ok) {
    return { kind: 'httpError', status: response.status, url }
  }

  try {
    const datafile = (await response.json()) as FlagDatafile
    return { kind: 'datafile', datafile, etag: headerOf(response, 'etag'), url }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return {
      kind: 'transportError',
      error: new Error(
        `AvsB got a response from ${hostOf(url)} that is not a valid datafile ` +
          `(${detail}). ${url} returned HTTP ${response.status}, but the body could ` +
          'not be parsed as JSON, which on an edge runtime usually means a proxy ' +
          'error page or a platform interstitial answered instead of the CDN. ' +
          'Request that URL directly to see what came back.',
      ),
      url,
    }
  }
}

// ---------------------------------------------------------------------
// evaluateFlagEdge
// ---------------------------------------------------------------------

export interface EvaluateFlagEdgeOptions {
  /**
   * Exposure sink. The evaluator calls it once per ab_test, bandit, or
   * holdout decision. Omit it ONLY for a deliberately read-only evaluation
   * (bulk reads); a normal `getFlag` must always pass one, which is the
   * `undefined` bug this parameter exists to prevent recurring.
   */
  onExposure?: (event: ExposureEvent) => void
}

/**
 * Evaluate a single flag against the supplied datafile and context.
 *
 * Returns a frozen `Flag<T>`. `datafile === null` yields `notReadyFlag`
 * (source `not_ready`), never `notFoundFlag`.
 */
export function evaluateFlagEdge<T>(
  flagKey: string,
  defaultValue: T,
  ctx: EvalContext,
  datafile: FlagDatafile | null,
  options: EvaluateFlagEdgeOptions = {},
): Flag<T> {
  if (!datafile) {
    return notReadyFlag<T>(defaultValue, NOT_READY_REASON)
  }

  // Reasons are collected on every edge evaluation: the evaluator only
  // fills a caller-supplied array, so without this `flag.reasons` would be
  // permanently empty here while node's was real.
  const reasons: string[] = []
  const start = Date.now()

  // The context is passed through as an `EvalContext`. The evaluator
  // normalises kinded contexts itself now, so the old
  // `toLegacyEvalContext(ctx)` hop is gone: it flattened a multi-context
  // into one attribute bag, which is exactly what broke kinded bucketing
  // (`hashAttribute: 'organization.tier'`) at the edge.
  const details = evaluateFlag(
    flagKey,
    defaultValue,
    ctx,
    datafile,
    options.onExposure,
    reasons,
  )

  return createFlag<T>({
    value: details.value as T,
    variationKey: details.variationKey,
    source: mapLegacySource(details.source),
    ruleId: details.ruleId,
    // The engine only sets ab_test | targeted_delivery | holdout | bandit;
    // anything else means a datafile rule type this build does not know.
    ruleType: details.ruleType ?? null,
    reasons: details.reasons,
    evaluatedAt: start,
    durationMicros: (Date.now() - start) * 1000,
  })
}

// ---------------------------------------------------------------------
// getAllFlagsEdge
// ---------------------------------------------------------------------

/**
 * Evaluate every flag in the datafile for one context.
 *
 * Returns an empty record when the datafile is null; the client is what
 * warns about that, because a bare empty map is indistinguishable from a
 * project with no flags.
 *
 * `onExposure` defaults to omitted. A bulk read is not a decision served to
 * a visitor, and firing an exposure per flag would attribute every visitor
 * to every experiment at once and destroy the results. This matches the
 * browser client's `getAllFlags({fireExposures})` default of false.
 */
export function getAllFlagsEdge(
  ctx: EvalContext,
  datafile: FlagDatafile | null,
  options: EvaluateFlagEdgeOptions = {},
): Record<string, Flag> {
  if (!datafile) return {}
  const result: Record<string, Flag> = {}
  for (const entry of datafile.flags) {
    result[entry.key] = evaluateFlagEdge(entry.key, undefined, ctx, datafile, options)
  }
  return result
}
