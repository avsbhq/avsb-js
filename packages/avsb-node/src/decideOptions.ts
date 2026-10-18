// Per-call `DecideOption` handling for the server SDK.
//
// Two members exist and both are accounted for (breaking change B4 deleted
// EXCLUDE_VARIABLES, IGNORE_STICKY_BUCKET, and ENABLED_FLAGS_ONLY, which no
// evaluator in any language read):
//
//   DISABLE_EXPOSURE  suppresses the exposure event for this evaluation.
//   INCLUDE_REASONS   asks for reason strings. This SDK collects reasons
//                     unconditionally, so passing it changes nothing here and
//                     `flag.reasons` is always populated. It is real in the
//                     ports where reason collection costs an allocation per
//                     evaluation (Go, Java, .NET) and is gated behind it, so
//                     one vocabulary spans the family.
//
// An unrecognised member (a plain-JS caller passing a deleted one, or a typo)
// is WARNED about once per process with the list of what is accepted, instead
// of being ignored. A silently ignored option is how the deleted three
// survived a release in docs while doing nothing.

import { DecideOption } from '@avsbhq/core'
import type { Logger } from '@avsbhq/core'

const KNOWN: readonly string[] = Object.values(DecideOption)

export interface ResolvedDecideOptions {
  suppressExposure: boolean
}

export function createDecideOptionResolver(
  logger: Logger
): (options: readonly DecideOption[] | undefined) => ResolvedDecideOptions {
  const warned = new Set<string>()

  return function resolve(options): ResolvedDecideOptions {
    if (!options || options.length === 0) return { suppressExposure: false }

    let suppressExposure = false
    for (const option of options) {
      if (option === DecideOption.DISABLE_EXPOSURE) {
        suppressExposure = true
        continue
      }
      if (option === DecideOption.INCLUDE_REASONS) {
        // Already on. Named explicitly so this is a decision, not a fallthrough.
        continue
      }
      const unknown = String(option)
      if (!warned.has(unknown)) {
        warned.add(unknown)
        logger.warn(
          `Unknown decide option "${unknown}" ignored. Accepted values are ` +
            `${KNOWN.join(', ')}. EXCLUDE_VARIABLES, IGNORE_STICKY_BUCKET and ` +
            'ENABLED_FLAGS_ONLY were deleted because no SDK ever implemented them.'
        )
      }
    }
    return { suppressExposure }
  }
}
