// =====================================================================
// Context handling the evaluator needs: the legacy-shape shim, dotted
// attribute resolution, the primary context, and the flat attribute bag
// an exposure carries.
//
// Moved out of evaluate.ts unchanged so the evaluator file holds the
// decision logic only. `resolveDottedAttribute` is still re-exported from
// ./evaluate, which is the path holdouts.ts and the package entry used.
// =====================================================================

import type {
  EvalContext,
  FlagDatafile,
  LegacyEvalContext,
  SingleContext,
} from './types'
import { buildExposureAttributes } from './exposureAttributes'
import { getContextByKind, isMultiContext } from './context'

const RESERVED_KEYS = new Set(['kind', 'key', 'name', '_meta'])

/**
 * Detect the legacy `{ attributes }` bag shape that older SDK callers
 * still produce via `toLegacyEvalContext`. Returns `true` when the
 * argument is a `LegacyEvalContext`, `false` when it's an `EvalContext`.
 */
export function isLegacyEvalContext(
  ctx: EvalContext | LegacyEvalContext
): ctx is LegacyEvalContext {
  return (
    typeof (ctx as { attributes?: unknown }).attributes === 'object' &&
    (ctx as { attributes?: unknown }).attributes !== null &&
    !('kind' in ctx)
  )
}

/**
 * Normalise a `LegacyEvalContext` (flat `{ attributes }` bag) into the
 * kinded `EvalContext` shape the new evaluator consumes natively.
 *
 *  - `attributes.userId` becomes the primary `user` sub-context `key`.
 *  - Keys shaped like `'<kind>.<attr>'` reconstitute additional kinded
 *    sub-contexts inside a `MultiContext` shell.
 *  - All other top-level keys go onto the user sub-context's attribute bag.
 *
 * This is the migration shim that lets pre-CoW6 callers (browser, node,
 * edge, next adapters) keep calling `evaluateFlag(...)` while the
 * evaluator internals run against the new shape end-to-end.
 */
export function fromLegacyEvalContext(legacy: LegacyEvalContext): EvalContext {
  const bag = legacy.attributes
  const userKey = bag['userId'] === undefined || bag['userId'] === null
    ? ''
    : String(bag['userId'])
  const user: SingleContext = { kind: 'user', key: userKey }
  const subContexts: Record<string, SingleContext> = { user }

  for (const [k, v] of Object.entries(bag)) {
    if (k === 'userId') continue
    const dotIdx = k.indexOf('.')
    if (dotIdx > 0) {
      const kind = k.substring(0, dotIdx)
      const attr = k.substring(dotIdx + 1)
      if (!subContexts[kind]) {
        subContexts[kind] = { kind, key: '' }
      }
      const sub = subContexts[kind]
      if (attr === 'key') {
        sub.key = String(v ?? '')
      } else if (attr === 'name') {
        sub.name = v === undefined || v === null ? undefined : String(v)
      } else if (!RESERVED_KEYS.has(attr)) {
        sub[attr] = v
      }
      continue
    }
    // Flat key (e.g. `plan`, `deviceId`) → user attribute.
    user[k] = v
  }

  // If only the user sub-context exists, return it directly to keep the
  // shape minimal. Multi-context only when extra kinds were promoted.
  const kinds = Object.keys(subContexts).filter((k) => k !== 'user')
  if (kinds.length === 0) return user
  const multi: Record<string, SingleContext | 'multi'> = { kind: 'multi' }
  for (const [k, v] of Object.entries(subContexts)) multi[k] = v
  return multi as EvalContext
}

/**
 * Resolve a single sub-context attribute, honouring the `'key'` / `'name'`
 * aliases for built-in fields and excluding reserved meta keys.
 */
function readSubContextAttribute(
  sub: SingleContext,
  attribute: string
): unknown {
  if (attribute === 'key') return sub.key
  if (attribute === 'name') return sub.name
  if (RESERVED_KEYS.has(attribute)) return undefined
  return sub[attribute]
}

/**
 * Return the primary single-context for an `EvalContext`. For a
 * `MultiContext` this is the `'user'` sub-context when present,
 * otherwise the first non-meta entry. For a `SingleContext` it is the
 * context itself.
 */
export function primaryContext(ctx: EvalContext): SingleContext | null {
  if (!isMultiContext(ctx)) return ctx
  const userSub = getContextByKind(ctx, 'user')
  if (userSub) return userSub
  for (const [kind, value] of Object.entries(ctx)) {
    if (kind === 'kind') continue
    if (!value || typeof value !== 'object') continue
    return value as SingleContext
  }
  return null
}

/**
 * Resolve a dotted attribute path against an `EvalContext`.
 *
 *   - `'user.key'` → key of the `'user'` sub-context.
 *   - `'organization.tier'` → `tier` attribute on the `'organization'` sub-context.
 *   - `'userId'` (no dot) → legacy fallback: returns the primary context's
 *      key, since v1 datafiles addressed the bucketing identifier as
 *      `userId`. Any other non-dotted path resolves against the primary
 *      context's attribute bag.
 *
 * Returns `undefined` when the path cannot be resolved.
 *
 * Exported for unit testing: the SDK conformance fixtures address this
 * function directly.
 */
export function resolveDottedAttribute(
  ctx: EvalContext,
  dottedPath: string
): unknown {
  if (!dottedPath) return undefined
  const dotIdx = dottedPath.indexOf('.')
  if (dotIdx > 0) {
    const kind = dottedPath.substring(0, dotIdx)
    const attr = dottedPath.substring(dotIdx + 1)
    const sub = getContextByKind(ctx, kind)
    if (!sub) return undefined
    return readSubContextAttribute(sub, attr)
  }
  // Non-dotted path — legacy v1 lookup against the primary context.
  const primary = primaryContext(ctx)
  if (!primary) return undefined
  if (dottedPath === 'userId') return primary.key
  return readSubContextAttribute(primary, dottedPath)
}

/**
 * Internal: collapses an `EvalContext` into the legacy attribute bag
 * expected by `buildExposureAttributes`. We can't import
 * `toLegacyEvalContext` because that adapter is built for the broader
 * SDK surface; the exposure path only needs the flat key→value map.
 */
export function buildExposureAttributesFor(
  ctx: EvalContext,
  datafile: FlagDatafile
): Record<string, string> | undefined {
  const attributes: Record<string, unknown> = {}
  const primary = primaryContext(ctx)
  if (primary) {
    attributes['userId'] = primary.key
    if (primary.name !== undefined) attributes['name'] = primary.name
    for (const [k, v] of Object.entries(primary)) {
      if (RESERVED_KEYS.has(k)) continue
      attributes[k] = v
    }
  }
  if (isMultiContext(ctx)) {
    for (const [kind, value] of Object.entries(ctx)) {
      if (kind === 'kind') continue
      if (!value || typeof value !== 'object') continue
      const sub = value as SingleContext
      attributes[`${kind}.key`] = sub.key
      if (sub.name !== undefined) attributes[`${kind}.name`] = sub.name
      for (const [k, v] of Object.entries(sub)) {
        if (RESERVED_KEYS.has(k)) continue
        attributes[`${kind}.${k}`] = v
      }
    }
  }
  return buildExposureAttributes({ attributes }, datafile)
}
