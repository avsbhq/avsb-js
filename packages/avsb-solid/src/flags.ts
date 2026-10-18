/**
 * Flag accessors.
 *
 * Every one returns a Solid `Accessor<Flag<T>>`: call it in JSX or in a memo
 * and it re-runs when that one flag changes, not when any flag changes.
 *
 * `flagKey` may be a string or an `Accessor<string>`; an accessor
 * re-subscribes when the key changes.
 *
 * The reads are render-safe: the same frozen object comes back until the
 * value actually changes, and no exposure is recorded. Use `createExposure`
 * where the decision is actually shown to the visitor.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from 'solid-js'
import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { useAvsbContext } from './context'
import { RENDER_SAFE, bindFlag, type FlagReader } from './internal/bindFlag'

/** A flag key, or an accessor holding one. */
export type FlagKeyInput = AvsbFlagKey | Accessor<AvsbFlagKey>

function keyOf(flagKey: FlagKeyInput): () => string {
  return typeof flagKey === 'function' ? flagKey : () => flagKey
}

function createFlagAccessor<T>(
  flagKey: FlagKeyInput,
  read: FlagReader<T>
): Accessor<Flag<T>> {
  const { client } = useAvsbContext()
  const resolveKey = keyOf(flagKey)

  // Seeded eagerly, so the FIRST render of a bootstrapped or cached client
  // shows the real value instead of the default. Default equality is
  // deliberate: the client returns the same object until the value changes,
  // which is exactly the signal we want.
  const [flag, setFlag] = createSignal<Flag<T>>(read(client, resolveKey()))

  createEffect(() => {
    const key = resolveKey()
    setFlag(() => read(client, key))
    onCleanup(
      bindFlag(client, key, read, (next) => {
        setFlag(() => next)
      })
    )
  })

  return flag
}

/** One flag as `Accessor<Flag<T>>`. */
export function createFlag<T>(
  flagKey: FlagKeyInput,
  defaultValue: T
): Accessor<Flag<T>> {
  return createFlagAccessor<T>(flagKey, (client, key) =>
    client.getSnapshot<T>(key, defaultValue)
  )
}

/** The flag's value on its own: `flag()` instead of `flag().value`. */
export function createFlagValue<T>(
  flagKey: FlagKeyInput,
  defaultValue: T
): Accessor<T> {
  const flag = createFlag<T>(flagKey, defaultValue)
  return createMemo(() => flag().value)
}

/**
 * A boolean flag, type-checked against the type the platform declared.
 *
 * On a mismatch nothing throws: the SDK logs one warning naming the flag and
 * the getter, and you get your `defaultValue` with `source: 'not_found'`.
 */
export function createBoolFlag(
  flagKey: FlagKeyInput,
  defaultValue: boolean
): Accessor<Flag<boolean>> {
  return createFlagAccessor<boolean>(flagKey, (client, key) =>
    client.getBoolFlag(key, defaultValue, RENDER_SAFE)
  )
}

/** A string flag, type-checked. A mismatch falls back to `defaultValue`. */
export function createStringFlag(
  flagKey: FlagKeyInput,
  defaultValue: string
): Accessor<Flag<string>> {
  return createFlagAccessor<string>(flagKey, (client, key) =>
    client.getStringFlag(key, defaultValue, RENDER_SAFE)
  )
}

/** A number flag, type-checked. A mismatch falls back to `defaultValue`. */
export function createNumberFlag(
  flagKey: FlagKeyInput,
  defaultValue: number
): Accessor<Flag<number>> {
  return createFlagAccessor<number>(flagKey, (client, key) =>
    client.getNumberFlag(key, defaultValue, RENDER_SAFE)
  )
}

/**
 * A JSON flag as `Flag<T>`. The runtime check is that the platform declared
 * this flag as JSON; the shape of `T` is not validated. Validate the payload
 * yourself if it crosses a trust boundary.
 */
export function createJsonFlag<T>(
  flagKey: FlagKeyInput,
  defaultValue: T
): Accessor<Flag<T>> {
  return createFlagAccessor<T>(flagKey, (client, key) =>
    client.getJsonFlag<T>(key, defaultValue, RENDER_SAFE)
  )
}

/**
 * Every flag in the environment, keyed by flag key, re-running on any change.
 * Prefer `createFlag` in components that read one flag; this is for debug
 * panels and admin views.
 *
 * Exposures are suppressed. Before the SDK is ready it is `{}` and the SDK
 * logs one line saying why, rather than looking like a project with no flags.
 */
export function createAllFlags(): Accessor<Record<string, Flag>> {
  const { client } = useAvsbContext()

  const [flags, setFlags] = createSignal<Record<string, Flag>>(
    client.getAllFlags()
  )

  createEffect(() => {
    setFlags(() => client.getAllFlags())
    onCleanup(
      client.on('flagChange', () => {
        setFlags(() => client.getAllFlags())
      })
    )
  })

  return flags
}
