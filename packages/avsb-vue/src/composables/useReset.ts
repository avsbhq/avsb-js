import { useAvsbContext } from '../context'

/**
 * Return to a new anonymous identity and clear runtime overrides. Call this
 * on sign-out.
 *
 * The persisted visitor id is rotated, so the next anonymous session is
 * genuinely a different visitor rather than the person who just signed out.
 *
 * One caveat when the A vs B web snippet is on the same page: the snippet
 * owns the visitor cookie and this SDK only reads it, so the next page load
 * adopts the snippet's id again unless the client was built with
 * `adoptSnippetVisitorId: false`.
 */
export function useReset(): () => void {
  const { client } = useAvsbContext()
  return (): void => {
    client.reset()
  }
}
