/**
 * The imperative half of the API: helpers that hand you a bound function.
 *
 * They all follow one rule, which is why they are named `get*`: Svelte
 * context can only be read while a component is initialising, so you call
 * `getTrack()` at the top of `<script>` and use the function it returns
 * whenever you like (in a handler, in `onMount`, in a timeout).
 *
 * Every helper also takes an optional `ctx` so it works outside a component.
 */
import type { AvsbFlagKey, EvalContext, Flag, TrackPayload } from '@avsbhq/core'
import type { SvelteAvsbClient } from './clientInterface'
import { useAvsbContext, type AvsbContextValue } from './context'
import { fireExposureWhenReady } from './internal/fireExposure'

/**
 * The underlying client, for the things the stores do not cover: runtime
 * overrides, `flush()`, `refresh()`, `updateAttributes()`.
 *
 * Never null: a provider either has a client or throws.
 *
 * Prefer the flag stores for reading flags; a direct `client.getFlag` in
 * markup fires an exposure every time the component renders.
 */
export function getAvsbClient(ctx?: AvsbContextValue): SvelteAvsbClient {
  return (ctx ?? useAvsbContext()).client
}

/**
 * Send a conversion or metric event.
 *
 *   const track = getTrack()
 *   <button onclick={() => track('checkout_started', { value: 99 })}>
 *
 * Events tracked before the SDK is ready are held (bounded) and flushed as
 * soon as it is.
 */
export function getTrack(
  ctx?: AvsbContextValue
): (eventKey: string, payload?: TrackPayload) => void {
  const { client } = ctx ?? useAvsbContext()
  return (eventKey: string, payload?: TrackPayload): void => {
    client.track(eventKey, payload)
  }
}

/**
 * Replace the evaluation context, typically after sign-in. Every flag is
 * re-evaluated, changed flags notify their subscribers, and bucketing
 * rehashes immediately.
 */
export function getIdentify(
  ctx?: AvsbContextValue
): (context: EvalContext) => void {
  const { client } = ctx ?? useAvsbContext()
  return (context: EvalContext): void => {
    client.identify(context)
  }
}

/**
 * Record that an anonymous visitor and a signed-in user are the same person,
 * so results can stitch the two sessions together.
 *
 * Synchronous: it queues one `avsb_alias` event and returns. It does not
 * rewrite assignments already made; to carry bucketing across a login,
 * evaluate with the same context key on both sides.
 */
export function getAlias(
  ctx?: AvsbContextValue
): (previousContext: EvalContext, newContext: EvalContext) => void {
  const { client } = ctx ?? useAvsbContext()
  return (previousContext: EvalContext, newContext: EvalContext): void => {
    client.alias(previousContext, newContext)
  }
}

/**
 * Return to a new anonymous identity and clear runtime overrides. Call this
 * on sign-out: the persisted visitor id is rotated, so the next anonymous
 * session is genuinely a different visitor.
 */
export function getReset(ctx?: AvsbContextValue): () => void {
  const { client } = ctx ?? useAvsbContext()
  return (): void => {
    client.reset()
  }
}

/**
 * Record that the visitor has been shown a flag's decision.
 *
 * Reading a flag never records an exposure, which is what keeps a re-render
 * from inflating your results. Call the returned function once, where the
 * variation is actually shown, or when the value came from the server:
 *
 *   const expose = getExposure()
 *   onMount(() => expose('new-checkout-flow'))
 *
 * If the SDK is not ready yet the exposure is deferred to the moment it is,
 * rather than dropped. Only decisions that belong in an experiment (A/B
 * rules, holdouts, bandits) produce an event.
 *
 * The call returns a cancel function, for the deferred case: a component
 * destroyed before the SDK became ready would otherwise still record an
 * exposure for a decision nobody is looking at any more. `onMount` passes
 * whatever you return to `onDestroy`, so the one-liner above already cancels
 * itself:
 *
 *   onMount(() => expose('new-checkout-flow')) // cancelled on destroy
 *
 * Calling it after the exposure has been recorded is a no-op.
 */
export function getExposure(
  ctx?: AvsbContextValue
): (flagKey: AvsbFlagKey) => () => void {
  const { client } = ctx ?? useAvsbContext()
  return (flagKey: AvsbFlagKey): (() => void) =>
    fireExposureWhenReady(client, flagKey)
}

/**
 * Run a side effect when one flag changes, without rendering anything.
 *
 * The callback also runs once when the first datafile lands, so a component
 * created before the SDK was ready still hears the real value. Returns the
 * unsubscribe function: pass it to `onDestroy`.
 *
 *   onDestroy(subscribeFlag('new-checkout-flow', (f) => log(f.variationKey)))
 */
export function subscribeFlag(
  flagKey: AvsbFlagKey,
  callback: (flag: Flag) => void,
  ctx?: AvsbContextValue
): () => void {
  const { client } = ctx ?? useAvsbContext()
  return client.subscribe(flagKey, () => {
    callback(client.getSnapshot<unknown>(flagKey, undefined))
  })
}
