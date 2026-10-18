// Datafile intake for AvsbEdgeClient: the constructor's `datafile` option
// check and the heartbeat that follows a network load. Split out of
// AvsbEdgeClient.ts (FU-31); the class is the only caller.

import type { FlagDatafile, Logger } from '@avsbhq/core'
import { datafileShapeProblem, resolveHeartbeatEndpoint } from '@avsbhq/core'
import type { EdgeErrorSource } from './types'
import { datafileRequestUrl } from './core'
import { sendHeartbeat } from './events'
import { logOnce } from './logger'
import { malformedDatafileMessage } from './messages'

/**
 * The `datafile` option, or null when it is malformed. A refused option is
 * logged once with the reason and the URL init() will load from instead
 * (N0-15).
 */
export function acceptOptionDatafile(
  datafile: FlagDatafile,
  sdkKey: string,
  cdnHost: string | undefined,
  logger: Logger,
): FlagDatafile | null {
  const problem = datafileShapeProblem(datafile)
  if (!problem) return datafile
  logOnce(
    logger,
    'error',
    `malformed-option:${sdkKey}`,
    malformedDatafileMessage(
      'option',
      problem,
      datafileRequestUrl(sdkKey, cdnHost),
    ),
  )
  return null
}

/** What a liveness report needs from the client. */
export interface LivenessInput {
  heartbeatEnabled: boolean
  datafile: FlagDatafile | null
  sdkKey: string
  logger: Logger
  notify: (error: Error, source: EdgeErrorSource) => void
}

/**
 * The heartbeat request to hand to `defer`, or null when none is due: the
 * client was built with `heartbeat: false`, or the datafile names no
 * heartbeat endpoint.
 */
export function livenessReport(input: LivenessInput): Promise<unknown> | null {
  if (!input.heartbeatEnabled) return null
  // null means "the publisher did not ask for heartbeats". Never guessed.
  const endpoint = resolveHeartbeatEndpoint(input.datafile?.heartbeatEndpoint)
  if (!endpoint) return null
  return sendHeartbeat(endpoint, input.sdkKey, input.logger, input.notify)
}
