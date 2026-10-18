import type { ReactAvsbClient } from './clientInterface'
import { useAvsbContext } from './context'

/**
 * The underlying client, or null before it exists.
 *
 * ```ts
 * function useAvsbClient(): ReactAvsbClient | null
 * ```
 *
 * It is null during a server render, and on the first client render of
 * Mode A (the provider builds the client in a layout effect, which runs
 * after that render and before paint). Guard for null, or use
 * `useAvsbClientSuspense()` when you would rather suspend.
 *
 * Prefer the flag hooks for reads: they subscribe, cache, and keep
 * exposures out of render. Reach for the client when you need something
 * the hooks do not cover, such as `flush()`, runtime overrides, or reading
 * a flag inside an event handler.
 *
 * Careful: `client.getFlag(key, default)` from an event handler DOES fire
 * an exposure. That is usually what you want there; inside render, it is
 * never what you want, which is why the hooks read a snapshot instead.
 */
export function useAvsbClient(): ReactAvsbClient | null {
  const { client } = useAvsbContext()
  return client
}
