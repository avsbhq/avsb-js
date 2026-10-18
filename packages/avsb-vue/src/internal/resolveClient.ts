import { AvsbClient } from '@avsbhq/browser'
import type { AvsbClientOptions } from '@avsbhq/browser'
import type { VueAvsbClient } from '../clientInterface'
import type { AvsbProviderProps } from '../types'
import { SDK_TYPE, SDK_VERSION } from '../version'

export interface ResolvedClient {
  client: VueAvsbClient
  /** True when we built the client, so we are the one who closes it. */
  owned: boolean
}

const MISUSE_MESSAGE =
  '[avsb] <AvsbProvider> needs either an sdk-key (Mode A) or a client (Mode B). ' +
  'Mode A: <AvsbProvider sdk-key="sdk_production_..." :context="{ kind: \'user\', key: userId }">. ' +
  'Mode B: <AvsbProvider :client="myClient">. ' +
  'The key for each environment is on app.avsb.cloud under Environments in the project sidebar.'

/**
 * Turn provider props into the one client the tree will use.
 *
 * Mode A builds an `AvsbClient`, which starts loading from its constructor.
 * Mode B adopts the caller's client untouched. Anything else throws here,
 * at setup, rather than rendering a tree whose flags are all defaults.
 */
export function resolveClient(props: AvsbProviderProps): ResolvedClient {
  const injected = (props as { client?: VueAvsbClient | null }).client
  if (injected !== undefined && injected !== null) {
    return { client: injected, owned: false }
  }

  const { sdkKey, context, bootstrap, options } = props as {
    sdkKey?: string
    context?: AvsbClientOptions['context']
    bootstrap?: AvsbClientOptions['bootstrap']
    options?: Partial<AvsbClientOptions>
  }

  if (typeof sdkKey !== 'string' || sdkKey.length === 0) {
    throw new Error(MISUSE_MESSAGE)
  }

  const clientOptions: AvsbClientOptions = {
    ...(options ?? {}),
    // Report @avsbhq/vue on the heartbeat, unless a package wrapping this one
    // (@avsbhq/nuxt) already named itself (N1-14).
    wrapper: options?.wrapper ?? { sdkType: SDK_TYPE, sdkVersion: SDK_VERSION },
    sdkKey,
    ...(context !== undefined ? { context } : {}),
    ...(bootstrap !== undefined ? { bootstrap } : {}),
  }

  return { client: new AvsbClient(clientOptions), owned: true }
}
