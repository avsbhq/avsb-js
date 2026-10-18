// =====================================================================
// Refuse a malformed datafile where it enters the browser client (N0-15).
//
// A hand-built bootstrap such as `{ flags: {} }`, or a body that parses as
// JSON but is not a datafile, used to be adopted as-is, and the first flag
// read threw from inside the evaluator although reads are documented never
// to throw. Each entry point now checks the shape once, with core's
// `datafileShapeProblem`, and refuses with a message naming the broken field:
//
//   bootstrap option          ignored; the client loads from cache or CDN
//   applyDatafileBootstrap()  ignored; the client keeps what it had
//   network response          a failed load (thrown, logged by the caller)
//   cached copy               discarded by the cache reader
// =====================================================================

import { datafileShapeProblem } from '@avsbhq/core'
import type { FlagDatafile, Logger } from '@avsbhq/core'

export type DatafileEntryPoint = 'bootstrap' | 'applyDatafileBootstrap'

export function malformedDatafileMessage(origin: DatafileEntryPoint, problem: string): string {
  const where =
    origin === 'bootstrap'
      ? 'the bootstrap datafile passed to new AvsbClient()'
      : 'the datafile passed to applyDatafileBootstrap()'
  const consequence =
    origin === 'bootstrap'
      ? 'The client loads a datafile from its cache or the CDN instead, and reads ' +
        'return the default you passed (source "not_ready") until one arrives.'
      : 'The client keeps serving the datafile it already has, if any.'
  return (
    `AvsB ignored ${where}: ${problem}. ${consequence} Pass the datafile JSON ` +
    'exactly as the CDN serves it for this SDK key.'
  )
}

/** The datafile when it is readable, or null after logging why it is not. */
export function acceptDatafile(
  candidate: unknown,
  origin: DatafileEntryPoint,
  logger: Logger
): FlagDatafile | null {
  const problem = datafileShapeProblem(candidate)
  if (problem === null) return candidate as FlagDatafile
  logger.error(malformedDatafileMessage(origin, problem))
  return null
}
