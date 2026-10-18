/**
 * The runes layer: `$state`-backed flag accessors for Svelte 5.
 *
 *   import { flagState } from '@avsbhq/svelte/runes'
 *
 *   const checkout = flagState('new-checkout-flow', false)
 *   // in markup: {#if checkout.current.value} ... {/if}
 *
 * Why a second layer at all: the store API needs the `$` prefix and only
 * auto-subscribes inside a component, while runes read like plain values and
 * are what a Svelte 5 codebase reaches for. Both layers share one
 * subscription implementation (`internal/bindFlag.ts`), so they cannot
 * report different values.
 *
 * WHERE THESE CAN BE CALLED: anywhere an effect can be created, which means
 * a component's `<script>`, or a `.svelte.ts` module or class INSTANTIATED
 * from one. Calling them from a plain module at import time gives you the
 * first value and no updates, because `$effect` needs an owner; wrap that
 * case in `$effect.root(() => …)` and call the returned cleanup yourself.
 * Passing `ctx` covers the context, not the effect owner: the two are
 * separate requirements.
 *
 * This file ships as SOURCE, not as bundled output: runes have to be compiled
 * by your app's Svelte compiler, which is also why it is on its own
 * `./runes` entry point rather than in the main barrel.
 */
import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { useAvsbContext, type AvsbContextValue } from '../context'
import { RENDER_SAFE, bindFlag, type FlagReader } from '../internal/bindFlag'
import type { AvsbStatusValue } from '../types'

/** What every flag accessor returns: one live, read-only `current`. */
export interface FlagState<T> {
  readonly current: Flag<T>
}

function createFlagState<T>(
  flagKey: AvsbFlagKey,
  read: FlagReader<T>,
  ctx?: AvsbContextValue
): FlagState<T> {
  const { client } = ctx ?? useAvsbContext()

  let current = $state<Flag<T>>(read(client, flagKey))

  // Re-read on mount (the datafile may have landed since initialisation) and
  // then on every change. The returned unsubscribe is the effect's teardown.
  $effect(() => {
    current = read(client, flagKey)
    return bindFlag(client, flagKey, read, (next) => {
      current = next
    })
  })

  return {
    get current(): Flag<T> {
      return current
    },
  }
}

/**
 * One flag. The read is render-safe: the same frozen object until the value
 * changes, and no exposure. Use `getExposure()` where the decision is shown.
 */
export function flagState<T>(
  flagKey: AvsbFlagKey,
  defaultValue: T,
  ctx?: AvsbContextValue
): FlagState<T> {
  return createFlagState<T>(
    flagKey,
    (client, key) => client.getSnapshot<T>(key, defaultValue),
    ctx
  )
}

/** A boolean flag, type-checked. A mismatch falls back to `defaultValue`. */
export function boolFlagState(
  flagKey: AvsbFlagKey,
  defaultValue: boolean,
  ctx?: AvsbContextValue
): FlagState<boolean> {
  return createFlagState<boolean>(
    flagKey,
    (client, key) => client.getBoolFlag(key, defaultValue, RENDER_SAFE),
    ctx
  )
}

/** A string flag, type-checked. A mismatch falls back to `defaultValue`. */
export function stringFlagState(
  flagKey: AvsbFlagKey,
  defaultValue: string,
  ctx?: AvsbContextValue
): FlagState<string> {
  return createFlagState<string>(
    flagKey,
    (client, key) => client.getStringFlag(key, defaultValue, RENDER_SAFE),
    ctx
  )
}

/** A number flag, type-checked. A mismatch falls back to `defaultValue`. */
export function numberFlagState(
  flagKey: AvsbFlagKey,
  defaultValue: number,
  ctx?: AvsbContextValue
): FlagState<number> {
  return createFlagState<number>(
    flagKey,
    (client, key) => client.getNumberFlag(key, defaultValue, RENDER_SAFE),
    ctx
  )
}

/**
 * A JSON flag as `Flag<T>`. The runtime check is that the platform declared
 * this flag as JSON; the shape of `T` is not validated.
 */
export function jsonFlagState<T>(
  flagKey: AvsbFlagKey,
  defaultValue: T,
  ctx?: AvsbContextValue
): FlagState<T> {
  return createFlagState<T>(
    flagKey,
    (client, key) => client.getJsonFlag<T>(key, defaultValue, RENDER_SAFE),
    ctx
  )
}

/** Every flag in the environment, refreshed on any change. */
export function allFlagsState(
  ctx?: AvsbContextValue
): { readonly current: Record<string, Flag> } {
  const { client } = ctx ?? useAvsbContext()

  let current = $state<Record<string, Flag>>(client.getAllFlags())

  $effect(() => {
    current = client.getAllFlags()
    return client.on('flagChange', () => {
      current = client.getAllFlags()
    })
  })

  return {
    get current(): Record<string, Flag> {
      return current
    },
  }
}

/**
 * The provider's status, error, and staleness as one live value:
 *
 *   const avsb = avsbStatusState()
 *   {#if avsb.current.degraded}<StaleNotice />{/if}
 */
export function avsbStatusState(
  ctx?: AvsbContextValue
): { readonly current: AvsbStatusValue } {
  const context = ctx ?? useAvsbContext()

  const snapshot = (): AvsbStatusValue => ({
    status: context.status,
    error: context.error,
    degraded: context.degraded,
  })

  let current = $state<AvsbStatusValue>(snapshot())

  $effect(() => {
    current = snapshot()
    return context.onStatusChange(() => {
      current = snapshot()
    })
  })

  return {
    get current(): AvsbStatusValue {
      return current
    },
  }
}
