import { useCallback, useRef } from 'react'
import type { EvalContext } from '@avsbhq/core'
import { useAvsbContext } from './context'

/**
 * §5.16: Returns a stable `identify` function.
 *
 * Calling `identify(ctx)` replaces the client's current evaluation
 * context. All subsequent flag evaluations and exposure events use the
 * new context. Triggers a re-render of any `useFlag` subscribers whose
 * evaluated values changed.
 *
 * @returns `(ctx: EvalContext) => void`
 */
export function useIdentify(): (ctx: EvalContext) => void {
  const { client } = useAvsbContext()

  const clientRef = useRef(client)
  clientRef.current = client

  return useCallback((ctx: EvalContext) => {
    const c = clientRef.current
    if (!c || typeof c.identify !== 'function') return
    c.identify(ctx)
  }, [])
}
