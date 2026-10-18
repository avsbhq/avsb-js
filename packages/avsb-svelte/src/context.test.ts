/**
 * N1-4 (production QA 2026-10-01): the documented
 * `import AvsbProvider from '@avsbhq/svelte/AvsbProvider.svelte'` threw on
 * mount, because that component ships as raw source and imports ./context
 * from src/, while `boolFlag` from the package root reads the bundled dist
 * copy. Each copy minted its own `Symbol('avsb-context')`, so the provider
 * set context under one key and the stores looked under another.
 *
 * Svelte's setContext/getContext are keyed lookups, so the fix is proven by
 * the key: two separately loaded copies of this module must hand out the
 * very same symbol.
 */
import { describe, expect, it, vi } from 'vitest'

async function freshContextModule(): Promise<typeof import('./context')> {
  vi.resetModules()
  return import('./context')
}

describe('AVSB_CONTEXT_KEY (N1-4)', () => {
  it('is the same symbol in two separately loaded copies of the module', async () => {
    const first = await freshContextModule()
    const second = await freshContextModule()

    // Two real module instances: their functions are distinct objects...
    expect(second.useAvsbContext).not.toBe(first.useAvsbContext)
    // ...but the key they set and read context under is one symbol.
    expect(second.AVSB_CONTEXT_KEY).toBe(first.AVSB_CONTEXT_KEY)
  })

  it('comes from the global registry, under a package-scoped name', async () => {
    const { AVSB_CONTEXT_KEY } = await freshContextModule()
    expect(Symbol.keyFor(AVSB_CONTEXT_KEY)).toBe('@avsbhq/svelte:context')
  })

  it('is not a key another library would pick by accident', async () => {
    const { AVSB_CONTEXT_KEY } = await freshContextModule()
    expect(AVSB_CONTEXT_KEY).not.toBe(Symbol.for('avsb-context'))
    expect(AVSB_CONTEXT_KEY).not.toBe(Symbol('@avsbhq/svelte:context'))
  })
})
