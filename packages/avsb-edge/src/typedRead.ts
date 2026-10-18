// =====================================================================
// The typed-getter type check.
//
// `getBoolFlag` and friends promise a type in their signature, so a flag the
// dashboard declares as a string must not come back as a string typed
// `boolean`. The check compares the datafile's declared type against the
// resolved value and, on a mismatch, returns the caller's default with
// `source: 'not_found'` plus a message naming BOTH types. It never coerces:
// a silent coercion is how a "boolean" flag ends up rendering the string
// "false" as truthy.
//
// Extracted from the client so the rule lives next to its message rather
// than inside a class, and so it is testable without constructing a client.
// =====================================================================

import {
  checkExpectedType,
  findDatafileFlag,
  flagNotFoundMessage,
  notFoundFlag,
} from '@avsbhq/core'
import type { ExpectedFlagType, Flag, FlagDatafile, Logger } from '@avsbhq/core'
import { logOnce } from './logger'
import { typedGetterMismatchMessage } from './messages'

/**
 * Check an already-evaluated flag against the type its getter promised.
 *
 * Returns the flag unchanged when the types agree, and a `not_found` flag
 * carrying `defaultValue` when they do not.
 *
 * A pre-init read passes straight through: `not_ready` is not a type
 * mismatch, and without this exemption the check would see "no datafile",
 * report the flag as missing, and undo B15 for every typed getter.
 */
export function checkTypedFlag<T>(
  flag: Flag<T>,
  input: {
    flagKey: string
    defaultValue: T
    expected: ExpectedFlagType
    datafile: FlagDatafile | null
    logger: Logger
  },
): Flag<T> {
  if (flag.source === 'not_ready') return flag

  // A key the datafile does not carry is not a type mismatch (N1-15). The
  // client's getFlag already reported the miss once per key, in its own
  // words; the old message called it "not a boolean flag".
  const declared = findDatafileFlag(input.datafile, input.flagKey)
  if (input.datafile && !declared) {
    if (flag.source === 'not_found') return flag
    logOnce(input.logger, 'warn', `missing:${input.flagKey}`, flagNotFoundMessage(input.flagKey))
    return notFoundFlag<T>(input.defaultValue, `flag "${input.flagKey}" not found in datafile`)
  }

  const typeError = checkExpectedType(declared, input.expected, flag.value)
  if (!typeError) return flag

  logOnce(
    input.logger,
    'warn',
    `typed:${input.flagKey}:${input.expected}`,
    typedGetterMismatchMessage(input.flagKey, input.expected, typeError),
  )
  return notFoundFlag<T>(input.defaultValue, typeError)
}
