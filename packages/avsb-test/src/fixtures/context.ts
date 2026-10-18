import type { EvalContext, SingleContext, MultiContext } from '@avsbhq/core'

/**
 * Create a minimal valid single-context for use in tests.
 * Defaults to `{ kind: 'user', key: 'test-user' }`.
 *
 * @example
 *   const ctx = createTestContext({ key: 'alice', plan: 'pro' })
 */
export function createTestContext(overrides?: Partial<SingleContext>): SingleContext {
  return {
    kind: 'user',
    key: 'test-user',
    ...overrides,
  }
}

/**
 * Create a multi-context from a map of kind → SingleContext.
 * The `kind: 'multi'` discriminator is added automatically.
 *
 * @example
 *   const ctx = createMultiTestContext({
 *     user: { kind: 'user', key: 'alice' },
 *     organization: { kind: 'organization', key: 'acme' },
 *   })
 */
export function createMultiTestContext(
  parts: Record<string, SingleContext>
): MultiContext {
  const result: Record<string, SingleContext | 'multi'> = { kind: 'multi' }
  for (const [kind, ctx] of Object.entries(parts)) {
    result[kind] = ctx
  }
  return result as MultiContext
}

// Re-export for consumers who want the type but not the full @avsbhq/core import
export type { EvalContext, SingleContext, MultiContext }
