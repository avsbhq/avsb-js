/**
 * Flag stores: the `svelte/store` layer.
 *
 * Every factory takes an optional `ctx`. Omit it inside a component (the
 * provider context is read for you); pass it when you are outside one, which
 * is what makes these testable and usable from plain modules.
 *
 * For a runes-native API (`$state`, no `$store` prefix) import from
 * `@avsbhq/svelte/runes` instead. Both layers share one subscription
 * implementation, so they cannot drift.
 */
import { derived, readable, type Readable } from 'svelte/store'
import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { useAvsbContext, type AvsbContextValue } from './context'
import { RENDER_SAFE } from './internal/bindFlag'
import { flagStore } from './internal/flagStore'

/**
 * One flag as `Readable<Flag<T>>`. In a component: `$checkout.value`,
 * `$checkout.isEnabled()`.
 *
 * The read is render-safe: the same frozen object until the value changes,
 * and no exposure. Use `getExposure()` where the decision is actually shown.
 */
export function flag<T>(
  flagKey: AvsbFlagKey,
  defaultValue: T,
  ctx?: AvsbContextValue
): Readable<Flag<T>> {
  const { client } = ctx ?? useAvsbContext()
  return flagStore<T>(client, flagKey, (c, key) =>
    c.getSnapshot<T>(key, defaultValue)
  )
}

/** The flag's value on its own: `$showBanner` instead of `$banner.value`. */
export function flagValue<T>(
  flagKey: AvsbFlagKey,
  defaultValue: T,
  ctx?: AvsbContextValue
): Readable<T> {
  return derived(flag<T>(flagKey, defaultValue, ctx), (f) => f.value)
}

/**
 * A boolean flag, type-checked against the type the platform declared.
 *
 * On a mismatch nothing throws: the SDK logs one warning naming the flag and
 * the getter, and you get your `defaultValue` with `source: 'not_found'`.
 */
export function boolFlag(
  flagKey: AvsbFlagKey,
  defaultValue: boolean,
  ctx?: AvsbContextValue
): Readable<Flag<boolean>> {
  const { client } = ctx ?? useAvsbContext()
  return flagStore<boolean>(client, flagKey, (c, key) =>
    c.getBoolFlag(key, defaultValue, RENDER_SAFE)
  )
}

/** A string flag, type-checked. A mismatch falls back to `defaultValue`. */
export function stringFlag(
  flagKey: AvsbFlagKey,
  defaultValue: string,
  ctx?: AvsbContextValue
): Readable<Flag<string>> {
  const { client } = ctx ?? useAvsbContext()
  return flagStore<string>(client, flagKey, (c, key) =>
    c.getStringFlag(key, defaultValue, RENDER_SAFE)
  )
}

/** A number flag, type-checked. A mismatch falls back to `defaultValue`. */
export function numberFlag(
  flagKey: AvsbFlagKey,
  defaultValue: number,
  ctx?: AvsbContextValue
): Readable<Flag<number>> {
  const { client } = ctx ?? useAvsbContext()
  return flagStore<number>(client, flagKey, (c, key) =>
    c.getNumberFlag(key, defaultValue, RENDER_SAFE)
  )
}

/**
 * A JSON flag as `Flag<T>`. The runtime check is that the platform declared
 * this flag as JSON; the shape of `T` is not validated. Validate the payload
 * yourself if it crosses a trust boundary.
 */
export function jsonFlag<T>(
  flagKey: AvsbFlagKey,
  defaultValue: T,
  ctx?: AvsbContextValue
): Readable<Flag<T>> {
  const { client } = ctx ?? useAvsbContext()
  return flagStore<T>(client, flagKey, (c, key) =>
    c.getJsonFlag<T>(key, defaultValue, RENDER_SAFE)
  )
}

/**
 * Every flag in the environment, keyed by flag key, re-emitting on any
 * change. Prefer `flag()` in components that read one flag; this is for
 * debug panels and admin views.
 *
 * Exposures are suppressed. Before the SDK is ready it is `{}` and the SDK
 * logs one line saying why, rather than looking like a project with no flags.
 */
export function allFlags(ctx?: AvsbContextValue): Readable<Record<string, Flag>> {
  const { client } = ctx ?? useAvsbContext()

  return readable<Record<string, Flag>>(client.getAllFlags(), (set) => {
    set(client.getAllFlags())
    return client.on('flagChange', () => {
      set(client.getAllFlags())
    })
  })
}
