/**
 * The imperative half of the API.
 *
 * Naming rule in this package: `create*` registers something reactive (a
 * signal, an effect, a subscription with cleanup); `use*` just reads the
 * provider context and hands you a plain function.
 */
import { createEffect, onCleanup } from 'solid-js'
import type { EvalContext, Flag, TrackPayload } from '@avsbhq/core'
import type { SolidAvsbClient } from './clientInterface'
import { useAvsbContext } from './context'
import { fireExposureWhenReady } from './internal/fireExposure'
import type { FlagKeyInput } from './flags'

/**
 * The underlying client, for the things the accessors do not cover: runtime
 * overrides, `flush()`, `refresh()`, `updateAttributes()`.
 *
 * Never null: a provider either has a client or throws.
 *
 * Prefer `createFlag` and friends for reading flags; a direct
 * `client.getFlag` in a component body fires an exposure on every render.
 */
export function useAvsbClient(): SolidAvsbClient {
  return useAvsbContext().client
}

/**
 * Send a conversion or metric event.
 *
 *   const track = useTrack()
 *   <button onClick={() => track('checkout_started', { value: 99 })}>
 *
 * Events tracked before the SDK is ready are held (bounded) and flushed as
 * soon as it is.
 */
export function useTrack(): (
  eventKey: string,
  payload?: TrackPayload
) => void {
  const { client } = useAvsbContext()
  return (eventKey: string, payload?: TrackPayload): void => {
    client.track(eventKey, payload)
  }
}

/**
 * Replace the evaluation context, typically after sign-in. Every flag is
 * re-evaluated, changed flags notify their subscribers, and bucketing
 * rehashes immediately.
 */
export function useIdentify(): (context: EvalContext) => void {
  const { client } = useAvsbContext()
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
export function useAlias(): (
  previousContext: EvalContext,
  newContext: EvalContext
) => void {
  const { client } = useAvsbContext()
  return (previousContext: EvalContext, newContext: EvalContext): void => {
    client.alias(previousContext, newContext)
  }
}

/**
 * Return to a new anonymous identity and clear runtime overrides. Call this
 * on sign-out: the persisted visitor id is rotated, so the next anonymous
 * session is genuinely a different visitor.
 */
export function useReset(): () => void {
  const { client } = useAvsbContext()
  return (): void => {
    client.reset()
  }
}

/**
 * Record that this visitor has been shown a flag's decision.
 *
 * Reading a flag never records an exposure, which is what keeps a re-render
 * from inflating your results. Call this once, in the component that actually
 * shows the variation, or when the value came from the server as a prop.
 *
 * Exactly ONE effect does the work, and that is load bearing. `onMount` is
 * `createEffect` plus `untrack` in Solid, and effects flush in creation
 * order, so pairing a mount hook with a tracking effect fires the exposure
 * twice on every mount: once from the mount hook, then again on the tracking
 * effect's first run. Both are real, non read-only evaluations with no
 * dedupe behind them, so every count in the results would be doubled.
 *
 * The single effect's first run is after the first render (never during it,
 * and never on the server); later runs happen only when a reactive key
 * changes. If the SDK is not ready yet the exposure is deferred to the
 * moment it is, and cancelled if this owner is disposed first.
 */
export function createExposure(flagKey: FlagKeyInput): void {
  const { client } = useAvsbContext()
  const resolveKey = typeof flagKey === 'function' ? flagKey : () => flagKey

  let cancel: (() => void) | undefined

  createEffect(() => {
    const key = resolveKey()
    cancel?.()
    cancel = fireExposureWhenReady(client, key)
  })

  onCleanup(() => {
    cancel?.()
    cancel = undefined
  })
}

/**
 * Run a side effect when one flag changes, without re-rendering.
 *
 * The callback also runs once when the first datafile lands, so a component
 * created before the SDK was ready still hears the real value. Use
 * `createFlag` when the value drives what you render; use this for analytics,
 * logging, or imperative work.
 *
 * The flag handed to the callback is a render-safe read: it records no
 * exposure.
 */
export function createFlagSubscription(
  flagKey: FlagKeyInput,
  callback: (flag: Flag) => void
): void {
  const { client } = useAvsbContext()
  const resolveKey = typeof flagKey === 'function' ? flagKey : () => flagKey

  createEffect(() => {
    const key = resolveKey()
    onCleanup(
      client.subscribe(key, () => {
        callback(client.getSnapshot<unknown>(key, undefined))
      })
    )
  })
}
