import type {
  EvalContext,
  SingleContext,
  MultiContext,
  LegacyEvalContext,
} from './types'

/**
 * Type guard: true when the value is a multi-context container.
 *
 * Multi-context uses the literal `kind: 'multi'` discriminator (LD-shaped)
 * and exposes per-kind single contexts as sibling properties.
 */
export function isMultiContext(ctx: EvalContext): ctx is MultiContext {
  return ctx.kind === 'multi'
}

/**
 * Extract a single context entry from a multi-context container, or
 * return the input when it is already a `SingleContext` matching `kind`.
 *
 * Returns `null` when the requested kind is not present.
 */
export function getContextByKind(
  ctx: EvalContext,
  kind: string
): SingleContext | null {
  if (isMultiContext(ctx)) {
    const candidate = (ctx as Record<string, unknown>)[kind]
    if (!candidate || typeof candidate !== 'object') return null
    const single = candidate as SingleContext
    return single.kind === kind ? single : null
  }
  return ctx.kind === kind ? ctx : null
}

/**
 * Adapt the public `EvalContext` to the internal `LegacyEvalContext` shape
 * consumed by the in-tree evaluator (`evaluate.ts`).
 *
 * Today's evaluator hashes on a single bag of attributes addressed by
 * `userId`. This adapter:
 *   - Maps the single context's `key` to `attributes.userId`.
 *   - Promotes all non-reserved fields to `attributes.<key>`.
 *   - For multi-context, flattens the `'user'` sub-context (when present)
 *     and exposes other kinds under their kind prefix (e.g.
 *     `organization.key`, `device.os`) for rule `hashAttribute` paths.
 *
 * Workstream 5 (CoW 6) rewrites the evaluator to consume `EvalContext`
 * natively; this adapter is removed at that point.
 */
export function toLegacyEvalContext(ctx: EvalContext): LegacyEvalContext {
  const attributes: Record<string, unknown> = {}
  const reserved = new Set(['kind', 'key', 'name', '_meta'])

  const single = isMultiContext(ctx) ? getContextByKind(ctx, 'user') : ctx

  if (single) {
    attributes['userId'] = single.key
    if (single.name !== undefined) attributes['name'] = single.name
    for (const [k, v] of Object.entries(single)) {
      if (!reserved.has(k)) attributes[k] = v
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
        if (reserved.has(k)) continue
        attributes[`${kind}.${k}`] = v
      }
    }
  }

  return { attributes }
}

/**
 * Convenience constructor for a single-context `user` context. Used by
 * the test harness and migration recipes.
 */
export function userContext(
  key: string,
  attributes?: Record<string, unknown>
): SingleContext {
  return { kind: 'user', key, ...(attributes ?? {}) }
}

/**
 * Surface the canonical bucketing key for a single-context lookup or
 * the `user` sub-context of a multi-context container. Returns the
 * empty string when no key is available, so callers receive a stable
 * sentinel rather than `undefined`.
 */
export function bucketingKey(
  ctx: EvalContext,
  kind: string = 'user'
): string {
  const single = getContextByKind(ctx, kind)
  return single ? single.key : ''
}

/**
 * Summarise a context to the kind/key pairs the decision log records.
 * Attributes are intentionally omitted because they may carry PII.
 */
export function contextSummary(
  ctx: EvalContext
): Array<{ kind: string; key: string }> {
  if (isMultiContext(ctx)) {
    const out: Array<{ kind: string; key: string }> = []
    for (const [kind, value] of Object.entries(ctx)) {
      if (kind === 'kind') continue
      if (!value || typeof value !== 'object') continue
      const sub = value as SingleContext
      out.push({ kind: sub.kind, key: sub.key })
    }
    return out
  }
  return [{ kind: ctx.kind, key: ctx.key }]
}

/**
 * Return the private-attribute redaction set declared on any sub-context.
 * Multi-context aggregates across all sub-contexts.
 */
export function privateAttributesFrom(ctx: EvalContext): Set<string> {
  const out = new Set<string>()
  const collect = (sub: SingleContext): void => {
    for (const key of sub._meta?.privateAttributes ?? []) out.add(key)
  }
  if (isMultiContext(ctx)) {
    for (const [kind, value] of Object.entries(ctx)) {
      if (kind === 'kind') continue
      if (!value || typeof value !== 'object') continue
      collect(value as SingleContext)
    }
  } else {
    collect(ctx)
  }
  return out
}
