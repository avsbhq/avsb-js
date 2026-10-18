// Flag reads for AvsbEdgeClient: the single read, the bulk read and the
// context fallback. Split out of AvsbEdgeClient.ts (FU-31); the class keeps
// the public getters and hands these its state.

import type { EvalContext, ExposureEvent, Flag, FlagDatafile, Logger } from '@avsbhq/core'
import { flagNotFoundMessage, notReadyFlag } from '@avsbhq/core'
import { contextForEvaluation } from './requestContext'
import { evaluateFlagEdge, getAllFlagsEdge } from './core'
import { logOnce } from './logger'
import {
  NOT_READY_REASON,
  allFlagsNotReadyMessage,
  emptyContextMessage,
  notReadyReadMessage,
} from './messages'

/** What one read needs from the client. */
export interface EdgeReadScope {
  datafile: FlagDatafile | null
  logger: Logger
  /** Called only once a datafile is loaded, so a pre-ready read logs nothing about context. */
  resolveContext: () => EvalContext
  /** The exposure sink, or undefined when this read fires none. */
  onExposure: ((event: ExposureEvent) => void) | undefined
}

/** The body of `AvsbEdgeClient.getFlag`. */
export function readEdgeFlag<T>(flagKey: string, defaultValue: T, scope: EdgeReadScope): Flag<T> {
  if (!scope.datafile) {
    logOnce(scope.logger, 'warn', `not-ready:${flagKey}`, notReadyReadMessage(flagKey))
    return notReadyFlag<T>(defaultValue, NOT_READY_REASON)
  }

  const flag = evaluateFlagEdge(flagKey, defaultValue, scope.resolveContext(), scope.datafile, {
    onExposure: scope.onExposure,
  })
  // Once per key per isolate, as a missing key (N1-15), with the platform
  // spelling suggested for a hyphenated key (N1-9).
  if (flag.source === 'not_found') {
    logOnce(scope.logger, 'warn', `missing:${flagKey}`, flagNotFoundMessage(flagKey))
  }
  return flag
}

/** The body of `AvsbEdgeClient.getAllFlags`. */
export function readAllEdgeFlags(scope: EdgeReadScope): Record<string, Flag> {
  if (!scope.datafile) {
    // Never silent: an empty map is indistinguishable from a project with
    // no flags.
    logOnce(scope.logger, 'warn', 'all-flags-not-ready', allFlagsNotReadyMessage())
    return {}
  }

  return getAllFlagsEdge(scope.resolveContext(), scope.datafile, {
    onExposure: scope.onExposure,
  })
}

/** The context to evaluate: the one passed, else the one bound at construction. */
export function resolveEdgeContext(
  override: EvalContext | undefined,
  boundContext: EvalContext | undefined,
  logger: Logger,
): EvalContext {
  return contextForEvaluation(override ?? boundContext, () =>
    logOnce(logger, 'warn', 'empty-context', emptyContextMessage()),
  )
}
