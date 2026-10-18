import { readable, type Readable } from 'svelte/store'
import type { Flag } from '@avsbhq/core'
import type { SvelteAvsbClient } from '../clientInterface'
import { bindFlag, type FlagReader } from './bindFlag'

/**
 * Build the `Readable<Flag<T>>` every flag store returns.
 *
 * The initial value is read at call time, so a bootstrapped or cached client
 * has real values in the store before the first subscriber runs. The
 * subscription is created when the store gets its first subscriber and torn
 * down when it loses its last, which is Svelte's own store lifecycle.
 */
export function flagStore<T>(
  client: SvelteAvsbClient,
  flagKey: string,
  read: FlagReader<T>
): Readable<Flag<T>> {
  return readable<Flag<T>>(read(client, flagKey), (set) => {
    // Re-read on subscribe: the datafile may have landed between the store
    // being created and something subscribing to it.
    set(read(client, flagKey))
    return bindFlag(client, flagKey, read, set)
  })
}
