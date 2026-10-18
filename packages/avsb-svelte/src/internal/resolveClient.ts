import { AvsbClient } from '@avsbhq/browser'
import type { AvsbClientOptions } from '@avsbhq/browser'
import type { SvelteAvsbClient } from '../clientInterface'
import type { AvsbProviderProps } from '../types'
import { SDK_TYPE, SDK_VERSION } from '../version'

export interface ResolvedClient {
  client: SvelteAvsbClient
  /** True when we built the client, so we are the one who closes it. */
  owned: boolean
}

const MISUSE_MESSAGE =
  '[avsb] AvsbProvider needs either an sdkKey (Mode A) or a client (Mode B). ' +
  'Mode A: <AvsbProvider sdkKey="sdk_production_..." context={{ kind: "user", key: userId }}>. ' +
  'Mode B: <AvsbProvider {client}>. ' +
  'The key for each environment is on app.avsb.cloud under Environments in the project sidebar.'

/**
 * Turn provider props into the one client the tree will use.
 *
 * Mode A builds an `AvsbClient`, which starts loading from its constructor.
 * Mode B adopts the caller's client untouched. Anything else throws here, at
 * initialisation, rather than rendering a tree whose flags are all defaults.
 */
export function resolveClient(props: AvsbProviderProps): ResolvedClient {
  const injected = (props as { client?: SvelteAvsbClient | null }).client
  if (injected !== undefined && injected !== null) {
    return { client: injected, owned: false }
  }

  const options = props as AvsbClientOptions
  if (typeof options.sdkKey !== 'string' || options.sdkKey.length === 0) {
    throw new Error(MISUSE_MESSAGE)
  }

  // Report @avsbhq/svelte on the heartbeat, not @avsbhq/browser (N1-14).
  return {
    client: new AvsbClient({
      ...options,
      wrapper: options.wrapper ?? { sdkType: SDK_TYPE, sdkVersion: SDK_VERSION },
    }),
    owned: true,
  }
}
