import { useCallback, useRef } from 'react'
import type { EvalContext } from '@avsbhq/core'
import { useAvsbContext } from './context'

/**
 * §5.16: Returns a stable `alias` function.
 *
 * Calling `alias(prev, next)` records that two contexts represent the
 * same user identity (e.g. anonymous visitor → identified user after
 * sign-in). This is used by the analytics backend to stitch sessions.
 *
 * @returns `(prev: EvalContext, next: EvalContext) => Promise<void>`
 */
export function useAlias(): (prev: EvalContext, next: EvalContext) => Promise<void> {
  const { client } = useAvsbContext()

  const clientRef = useRef(client)
  clientRef.current = client

  return useCallback(async (prev: EvalContext, next: EvalContext): Promise<void> => {
    const c = clientRef.current
    if (!c || typeof c.alias !== 'function') return
    await c.alias(prev, next)
  }, [])
}
