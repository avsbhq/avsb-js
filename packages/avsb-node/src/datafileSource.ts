// Datafile transport for the server SDK: one fetch, one heartbeat, both
// composing their URLs through the @avsbhq/core endpoint contract (spec §1.1)
// instead of string-building a host.
//
// Extracted from AvsbServer so the class holds lifecycle and evaluation, and
// so the failure MESSAGES are testable on their own. Every failure names the
// status, the URL tried, and where the key lives, per spec §1.2.

import { datafileShapeProblem, datafileUrl, resolveHeartbeatEndpoint } from '@avsbhq/core'
import type { FlagDatafile, Logger } from '@avsbhq/core'

export interface FetchDatafileInput {
  sdkKey: string
  cdnHost?: string
  signal: AbortSignal
  logger: Logger
  /** ETag of the datafile currently held, for a conditional request. */
  etag?: string | null
}

export type FetchDatafileOutcome =
  /** A new datafile arrived. */
  | { status: 'ok'; datafile: FlagDatafile; etag: string | null }
  /** The CDN confirmed what we already hold (304). */
  | { status: 'not-modified' }
  /** The request was aborted by `close()`. Not an error. */
  | { status: 'aborted' }
  /** Anything else. Already logged, with the reason. */
  | { status: 'failed' }

/**
 * Fetch the datafile for one SDK key.
 *
 * Never throws and never returns a partially applied datafile: the caller
 * keeps serving whatever it already had.
 */
export async function fetchDatafile(
  input: FetchDatafileInput
): Promise<FetchDatafileOutcome> {
  const url = datafileUrl(input.sdkKey, input.cdnHost)
  const headers: Record<string, string> = {}
  if (input.etag) headers['If-None-Match'] = input.etag

  try {
    const response = await fetch(url, { signal: input.signal, headers })

    if (response.status === 304) return { status: 'not-modified' }

    if (!response.ok) {
      input.logger.error(
        `AvsB datafile request failed with HTTP ${response.status} for ${url}. ` +
          (response.status === 404
            ? 'That SDK key has no published datafile: check the key belongs to this ' +
              'environment and that the environment has been published at least once ' +
              '(app.avsb.cloud, then Environments in the project sidebar).'
            : 'The SDK keeps serving whatever datafile it already has and retries on ' +
              'the polling interval.')
      )
      return { status: 'failed' }
    }

    const body: unknown = await response.json()
    // A body that parses but is not a datafile (a proxy error page served as
    // JSON, a truncated object) must never reach the evaluator (N0-15).
    const problem = datafileShapeProblem(body)
    if (problem) {
      input.logger.error(
        `AvsB datafile from ${url} is not a datafile the SDK can read: ${problem}. ` +
          'The SDK keeps serving whatever datafile it already has and retries on ' +
          'the polling interval.'
      )
      return { status: 'failed' }
    }
    return { status: 'ok', datafile: body as FlagDatafile, etag: response.headers.get('etag') }
  } catch (error) {
    if (input.signal.aborted) return { status: 'aborted' }
    input.logger.error(
      `AvsB datafile request to ${url} could not complete: ${String(error)}. ` +
        'This is a network, DNS, or TLS failure rather than a rejected key; the SDK ' +
        'retries on the polling interval.'
    )
    return { status: 'failed' }
  }
}

/**
 * A datafile handed to the SDK directly (the `bootstrap` option,
 * `applyDatafileBootstrap`), or null after logging why it cannot be used.
 *
 * N0-15: `bootstrap: { flags: {} }` used to be adopted as-is, and the first
 * flag read threw a TypeError from inside the evaluator although reads are
 * documented never to throw. Refusing it here leaves the SDK not ready, so
 * reads answer with the caller's default and `source: "not_ready"`.
 */
export function acceptDatafile(
  candidate: unknown,
  origin: 'bootstrap' | 'applyDatafileBootstrap',
  logger: Logger
): FlagDatafile | null {
  const problem = datafileShapeProblem(candidate)
  if (problem === null) return candidate as FlagDatafile
  logger.error(
    origin === 'bootstrap'
      ? `AvsB ignored the bootstrap datafile passed to new AvsbServer(): ${problem}. ` +
          'Flags return the default you passed, with source "not_ready", until a ' +
          'datafile loads from the CDN. Pass the datafile JSON exactly as the CDN ' +
          'serves it for this SDK key.'
      : `AvsB ignored the datafile passed to applyDatafileBootstrap(): ${problem}. ` +
          'The SDK keeps serving the datafile it already has, if any. Pass the ' +
          'datafile JSON exactly as the CDN serves it for this SDK key.'
  )
  return null
}

export interface HeartbeatInput {
  sdkKey: string
  sdkType: string
  sdkVersion: string
  /** `heartbeatEndpoint` exactly as the datafile published it. */
  datafileHeartbeatEndpoint?: string | null
  signal: AbortSignal
}

/**
 * Post one liveness heartbeat.
 *
 * The dashboard's Environments page reads these: it shows Connected / Stale /
 * Not connected per environment along with the `sdkType` and `sdkVersion` that
 * last reported, which is how a customer sees "this environment is running
 * @avsbhq/node 1.6.2". Fire and forget by design: a heartbeat must never
 * affect evaluation, so a failure is dropped rather than retried.
 *
 * Returns the endpoint it posted to, or null when the datafile carries none
 * (a self-hosted or proxied deployment publishes its own origin, and posting
 * to a guessed host would report liveness nowhere while looking healthy).
 */
export function sendHeartbeat(input: HeartbeatInput): string | null {
  const endpoint = resolveHeartbeatEndpoint(input.datafileHeartbeatEndpoint)
  if (!endpoint) return null

  void fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sdkKey: input.sdkKey,
      sdkType: input.sdkType,
      sdkVersion: input.sdkVersion,
    }),
    signal: input.signal,
  }).catch(() => undefined)

  return endpoint
}
