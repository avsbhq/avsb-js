import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import type { SvelteAvsbClient } from '../clientInterface'

/** How one store or accessor reads its flag. Always a render-safe read. */
export type FlagReader<T> = (client: SvelteAvsbClient, flagKey: AvsbFlagKey) => Flag<T>

/**
 * Options every render-path read passes.
 *
 * `readOnly` is the whole point: it returns the same frozen object until the
 * value changes, and fires NO exposure, because rendering is a read, not a
 * decision. Without it, exposure counts become a function of how often a
 * component re-renders and experiment results are quietly wrong.
 */
export const RENDER_SAFE = { readOnly: true } as const

/**
 * Subscribe to one flag and push every new value into `onChange`.
 *
 * Returns the unsubscribe function. Shared by the store layer
 * (`svelte/store`) and the runes layer (`.svelte.ts`), so both have exactly
 * one definition of "when does this update".
 *
 * The callback also runs once when the first datafile is applied, which is
 * what moves a component mounted during init off `not_ready` without a poll.
 */
export function bindFlag<T>(
  client: SvelteAvsbClient,
  flagKey: string,
  read: FlagReader<T>,
  onChange: (flag: Flag<T>) => void
): () => void {
  return client.subscribe(flagKey, () => {
    onChange(read(client, flagKey))
  })
}
