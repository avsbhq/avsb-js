import { useCallback, useRef } from 'react'
import { useAvsbContext } from './context'

/**
 * A stable `reset` function.
 *
 * ```ts
 * function useReset(): () => void
 * ```
 *
 * Call it on sign-out. It returns the client to a NEW anonymous identity
 * (the persisted visitor id is rotated, so the next anonymous session is
 * genuinely a different visitor rather than the person who just signed
 * out) and clears runtime overrides.
 *
 * One caveat when the A vs B web snippet is installed on the same page:
 * the snippet owns the visitor cookie and this SDK only reads it, so the
 * next page load adopts the snippet's id again. Construct the client with
 * `adoptSnippetVisitorId: false` if you want its identity to be entirely
 * its own.
 *
 * The returned function never changes identity, so it is safe in a
 * dependency array.
 */
export function useReset(): () => void {
  const { client } = useAvsbContext()

  const clientRef = useRef(client)
  clientRef.current = client

  return useCallback(() => {
    clientRef.current?.reset()
  }, [])
}
