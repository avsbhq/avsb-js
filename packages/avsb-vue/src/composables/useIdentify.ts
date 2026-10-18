import type { EvalContext } from '@avsbhq/core'
import { useAvsbContext } from '../context'

/**
 * Replace the evaluation context, typically after sign-in.
 *
 * Every flag is re-evaluated, changed flags notify their subscribers, and
 * bucketing rehashes immediately.
 *
 * The returned function is created once per component, so it is safe to pass
 * straight to an event handler.
 */
export function useIdentify(): (context: EvalContext) => void {
  const { client } = useAvsbContext()
  return (context: EvalContext): void => {
    client.identify(context)
  }
}
