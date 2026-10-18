import type {
  LegacyEvalContext,
  FlagDatafile,
  RegisteredAttribute,
} from './types'

/**
 * Filter the eval context's attributes down to the project's registered keys
 * and stringify the values so they fit ClickHouse Map(String, String).
 *
 * - Unknown keys are dropped silently (privacy + cardinality guard).
 * - undefined / null values are skipped (no point sending "undefined").
 * - Object values become JSON.stringify(value); primitives become String(value).
 * - Returns undefined when no keys survive, so callers can omit the field.
 *
 * Accepts the v1 `string[]` and v2 `RegisteredAttribute[]` shapes for the
 * registered-attribute registry.
 */
export function buildExposureAttributes(
  context: LegacyEvalContext,
  datafile: Pick<FlagDatafile, 'registeredAttributes'>
): Record<string, string> | undefined {
  const registered = datafile.registeredAttributes
  if (!registered || registered.length === 0) return undefined

  const allowed = new Set<string>(
    (registered as (RegisteredAttribute | string)[]).map((entry) =>
      typeof entry === 'string' ? entry : entry.key
    )
  )
  const out: Record<string, string> = {}
  let any = false

  for (const key of Object.keys(context.attributes)) {
    if (!allowed.has(key)) continue
    const value = context.attributes[key]
    if (value === undefined || value === null) continue
    out[key] =
      typeof value === 'object' ? JSON.stringify(value) : String(value)
    any = true
  }

  return any ? out : undefined
}
