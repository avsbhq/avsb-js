import type { FlagDatafile, FlagDatafileEntry } from './types'

export type ExpectedFlagType = 'boolean' | 'string' | 'number' | 'json'

/**
 * Runtime check: does the resolved value match the type the platform
 * declared for `flagKey`? Used by `getBool/String/Number/JsonFlag`
 * variants so a typed call against a misconfigured flag is loud rather
 * than silently coerced.
 *
 * Returns `null` when the flag matches the expected type, or a
 * human-readable reason when it doesn't.
 */
export function checkExpectedType(
  flag: FlagDatafileEntry | undefined,
  expected: ExpectedFlagType,
  value: unknown
): string | null {
  if (!flag) {
    return `flag declared as "${expected}" was not found in the datafile`
  }
  if (flag.type !== expected) {
    return `flag "${flag.key}" is declared as "${flag.type}" in the datafile but a "${expected}" variant was requested`
  }

  switch (expected) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        return `flag "${flag.key}" resolved to a non-boolean value (typeof === "${typeof value}")`
      }
      break
    case 'string':
      if (typeof value !== 'string') {
        return `flag "${flag.key}" resolved to a non-string value (typeof === "${typeof value}")`
      }
      break
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return `flag "${flag.key}" resolved to a non-number value (typeof === "${typeof value}")`
      }
      break
    case 'json':
      // JSON variations may be primitives, arrays, or objects — any
      // value that survives JSON.parse round-trips. The check rejects
      // `undefined` (not valid JSON) and lets everything else through.
      if (value === undefined) {
        return `flag "${flag.key}" resolved to undefined which is not valid JSON`
      }
      break
  }

  return null
}

export function findDatafileFlag(
  datafile: FlagDatafile | null,
  flagKey: string
): FlagDatafileEntry | undefined {
  if (!datafile) return undefined
  return datafile.flags.find((f) => f.key === flagKey)
}
