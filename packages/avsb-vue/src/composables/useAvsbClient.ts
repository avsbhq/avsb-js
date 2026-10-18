import type { VueAvsbClient } from '../clientInterface'
import { useAvsbContext } from '../context'

/**
 * The underlying client, for the things composables do not cover: runtime
 * overrides, `flush()`, `refresh()`, `updateAttributes()`.
 *
 * Never null: a provider either has a client or throws at setup.
 *
 * Prefer `useFlag` and friends for reading flags; a direct `client.getFlag`
 * in a component body fires an exposure on every render.
 */
export function useAvsbClient(): VueAvsbClient {
  return useAvsbContext().client
}
