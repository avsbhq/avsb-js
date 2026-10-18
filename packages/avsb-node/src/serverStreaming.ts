// The SSE datafile stream for AvsbServer. Split out of AvsbServer.ts (FU-31).

import { resolveStreamEndpoint } from '@avsbhq/core'
import { createStreamingClient } from './streaming'
import type { ServerState } from './serverState'

/**
 * Open the SSE stream when one is available, and fall back to polling in
 * silence when it is not (B12). The endpoint comes from the datafile's
 * `streamEndpoint` field, or an explicit option; it is never guessed from
 * another host, which is what gave one port an infinite reconnect loop
 * against DNS that does not resolve.
 *
 * `onDatafileUpdated` is the stream-triggered reload, passed in so this
 * module does not import the loader that calls it.
 */
export function startStreamingIfEnabled(
  s: ServerState,
  onDatafileUpdated: () => void
): void {
  if (!s.streamingEnabled || s.streamingClient || s.destroyed) return

  const resolution = resolveStreamEndpoint({
    optionEndpoint: s.streamingEndpointOption,
    datafileStreamEndpoint: s.datafile?.streamEndpoint ?? null,
  })

  if (!resolution.available) {
    // Not an error: polling already delivers changes. Debug level so a
    // developer looking for "why am I not getting instant updates" finds the
    // reason, without warning a healthy production process on every boot.
    s.logger.debug(`Streaming stays off, polling continues. ${resolution.reason}`)
    return
  }

  s.streamingClient = createStreamingClient({
    endpoint: resolution.endpoint,
    sdkKey: s.sdkKey,
    onDatafileUpdated,
    logger: s.logger,
  })
  s.streamingClient.connect()
  s.logger.debug(
    `Streaming datafile updates from ${resolution.endpoint} (${resolution.source}).`
  )
}
