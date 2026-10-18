// Context helpers — typed schema, merge, redact, anonymous-id generation,
// and visitor-data context builders. Spec §6.3.
//
// `defineContextSchema` is the compile-time linkage differentiator: a
// chainable, fully-typed `EvalContext` builder. Optional CLI lint (Workstream
// 5) cross-references the declared schema fields with platform-side
// `registeredAttributes` to catch typos at build time.

import type { z } from 'zod'
import type {
  EvalContext,
  SingleContext,
  MultiContext,
} from '@avsbhq/core'
import {
  isMultiContext,
  privateAttributesFrom as corePrivateAttributesFrom,
} from '@avsbhq/core'

export type ContextSchema = Record<string, z.ZodTypeAny>

export interface ContextBuilder<S extends ContextSchema> {
  setUser(key: string, attrs?: Partial<InferKindAttrs<S, 'user'>>): ContextBuilder<S>
  setOrganization(
    key: string,
    attrs?: Partial<InferKindAttrs<S, 'organization'>>
  ): ContextBuilder<S>
  setDevice(
    key: string,
    attrs?: Partial<InferKindAttrs<S, 'device'>>
  ): ContextBuilder<S>
  setWorkspace(
    key: string,
    attrs?: Partial<InferKindAttrs<S, 'workspace'>>
  ): ContextBuilder<S>
  /** Generic setter for any caller-defined kind. */
  setKind(
    kind: string,
    key: string,
    attrs?: Record<string, unknown>
  ): ContextBuilder<S>
  build(): EvalContext
}

type InferKindAttrs<S extends ContextSchema, K extends string> =
  K extends keyof S
    ? S[K] extends z.ZodTypeAny
      ? z.infer<S[K]>
      : Record<string, unknown>
    : Record<string, unknown>

export interface DefinedContextSchema<S extends ContextSchema> {
  builder(): ContextBuilder<S>
  /** Runtime validation: returns a SafeParseReturnType. */
  validate(
    ctx: EvalContext
  ):
    | { success: true; data: EvalContext }
    | { success: false; error: SchemaError }
  /** Raw schema map (kind → ZodTypeAny). */
  readonly schema: S
}

export interface SchemaError {
  issues: Array<{ kind: string; path: (string | number)[]; message: string }>
}

function makeBuilder<S extends ContextSchema>(): ContextBuilder<S> {
  const entries: Record<string, SingleContext> = {}

  const setKind = (
    kind: string,
    key: string,
    attrs?: Record<string, unknown>
  ): ContextBuilder<S> => {
    entries[kind] = { kind, key, ...(attrs ?? {}) }
    return api
  }

  const api: ContextBuilder<S> = {
    setUser: (key, attrs) =>
      setKind('user', key, attrs as Record<string, unknown> | undefined),
    setOrganization: (key, attrs) =>
      setKind('organization', key, attrs as Record<string, unknown> | undefined),
    setDevice: (key, attrs) =>
      setKind('device', key, attrs as Record<string, unknown> | undefined),
    setWorkspace: (key, attrs) =>
      setKind('workspace', key, attrs as Record<string, unknown> | undefined),
    setKind,
    build() {
      const kinds = Object.keys(entries)
      if (kinds.length === 0) {
        throw new Error(
          'ContextBuilder.build(): at least one kind must be set before build()'
        )
      }
      if (kinds.length === 1) {
        return entries[kinds[0]]
      }
      const out: Record<string, unknown> = { kind: 'multi' }
      for (const k of kinds) out[k] = entries[k]
      return out as MultiContext
    },
  }
  return api
}

export function defineContextSchema<S extends ContextSchema>(
  schema: S
): DefinedContextSchema<S> {
  return {
    schema,
    builder: () => makeBuilder<S>(),
    validate(ctx) {
      const issues: SchemaError['issues'] = []
      const checkKind = (sub: SingleContext): void => {
        const kindSchema = schema[sub.kind]
        if (!kindSchema) return
        const { kind: _kind, key: _key, name: _name, _meta: _meta, ...attrs } =
          sub
        const result = kindSchema.safeParse(attrs)
        if (!result.success) {
          for (const issue of result.error.issues) {
            issues.push({
              kind: sub.kind,
              path: issue.path,
              message: issue.message,
            })
          }
        }
      }
      if (isMultiContext(ctx)) {
        for (const [k, v] of Object.entries(ctx)) {
          if (k === 'kind') continue
          if (!v || typeof v !== 'object') continue
          checkKind(v as SingleContext)
        }
      } else {
        checkKind(ctx)
      }
      if (issues.length > 0) {
        return { success: false, error: { issues } }
      }
      return { success: true, data: ctx }
    },
  }
}

// ---------------------------------------------------------------------------
// mergeContext — patches a partial update into a single or multi context.
// Merging into a single-context produces a single-context. Merging into a
// multi-context applies per-kind overrides.
// ---------------------------------------------------------------------------

export function mergeContext(
  base: EvalContext,
  patch: Partial<EvalContext>
): EvalContext {
  if (isMultiContext(base)) {
    const out: Record<string, unknown> = { kind: 'multi' }
    for (const [k, v] of Object.entries(base)) {
      if (k === 'kind') continue
      out[k] = v
    }
    if (isMultiContext(patch as EvalContext)) {
      for (const [k, v] of Object.entries(patch as MultiContext)) {
        if (k === 'kind') continue
        const existing = out[k] as SingleContext | undefined
        out[k] = existing
          ? { ...existing, ...(v as SingleContext) }
          : (v as SingleContext)
      }
    } else if (patch && typeof patch === 'object' && 'kind' in patch) {
      const kind = (patch as SingleContext).kind
      const existing = out[kind] as SingleContext | undefined
      out[kind] = existing
        ? { ...existing, ...(patch as SingleContext) }
        : (patch as SingleContext)
    }
    return out as MultiContext
  }
  return { ...(base as SingleContext), ...(patch as Record<string, unknown>) } as SingleContext
}

// ---------------------------------------------------------------------------
// redactAttributes — return a copy with the named keys replaced by
// '[REDACTED]'. Wrapper around the core helper that also accepts the keys
// declared inline.
// ---------------------------------------------------------------------------

export function redactAttributes(
  ctx: EvalContext,
  privateKeys: string[]
): EvalContext {
  const declared = corePrivateAttributesFrom(ctx)
  const redact = new Set([...declared, ...privateKeys])

  const scrub = (sub: SingleContext): SingleContext => {
    const out: SingleContext = { kind: sub.kind, key: sub.key }
    if (sub.name !== undefined) out.name = sub.name
    if (sub._meta) out._meta = sub._meta
    for (const [k, v] of Object.entries(sub)) {
      if (['kind', 'key', 'name', '_meta'].includes(k)) continue
      out[k] = redact.has(k) ? '[REDACTED]' : v
    }
    return out
  }

  if (isMultiContext(ctx)) {
    const out: Record<string, unknown> = { kind: 'multi' }
    for (const [k, v] of Object.entries(ctx)) {
      if (k === 'kind') continue
      if (!v || typeof v !== 'object') continue
      out[k] = scrub(v as SingleContext)
    }
    return out as MultiContext
  }
  return scrub(ctx)
}

// ---------------------------------------------------------------------------
// anonymousId — generate a stable random id for anonymous visitors. Used by
// the browser SDK before a user signs up so bucketing survives the
// anonymous→identified transition (via `alias()`).
// ---------------------------------------------------------------------------

export function anonymousId(): string {
  // crypto.randomUUID is available in Node 19+, browsers, edge runtimes.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return `anon_${c.randomUUID()}`
  // Fallback: 16 random bytes as hex.
  let hex = ''
  for (let i = 0; i < 32; i++) {
    hex += Math.floor(Math.random() * 16).toString(16)
  }
  return `anon_${hex}`
}

// ---------------------------------------------------------------------------
// Re-export the core helpers so consumers get a single import surface.
// ---------------------------------------------------------------------------

export {
  isMultiContext,
  getContextByKind,
  userContext,
  bucketingKey,
  contextSummary,
} from '@avsbhq/core'
