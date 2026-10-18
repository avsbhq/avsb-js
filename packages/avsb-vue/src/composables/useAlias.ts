import type { EvalContext } from '@avsbhq/core'
import { useAvsbContext } from '../context'

/**
 * Record that an anonymous visitor and a signed-in user are the same person,
 * so results can stitch the two sessions together.
 *
 * Synchronous: it queues one `avsb_alias` event and returns. There is
 * nothing to await, and it does not rewrite assignments already made. To
 * carry bucketing across a login, evaluate with the same context key on both
 * sides.
 */
export function useAlias(): (
  previousContext: EvalContext,
  newContext: EvalContext
) => void {
  const { client } = useAvsbContext()
  return (previousContext: EvalContext, newContext: EvalContext): void => {
    client.alias(previousContext, newContext)
  }
}
