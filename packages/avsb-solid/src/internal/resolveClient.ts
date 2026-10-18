import { AvsbClient } from '@avsbhq/browser'
import type { AvsbClientOptions } from '@avsbhq/browser'
import type { SolidAvsbClient } from '../clientInterface'
import type { AvsbProviderProps } from '../types'
import { SDK_TYPE, SDK_VERSION } from '../version'

export interface ResolvedClient {
  client: SolidAvsbClient
  /** True when we built the client, so we are the one who closes it. */
  owned: boolean
}

const MISUSE_MESSAGE =
  '[avsb] <AvsbProvider> needs either an sdkKey (Mode A) or a client (Mode B). ' +
  'Mode A: <AvsbProvider sdkKey="sdk_production_..." context={{ kind: "user", key: userId }}>. ' +
  'Mode B: <AvsbProvider client={myClient}>. ' +
  'The key for each environment is on app.avsb.cloud under Environments in the project sidebar.'

/**
 * Turn provider props into the one client the tree will use.
 *
 * Mode A builds an `AvsbClient`, which starts loading from its constructor.
 * Mode B adopts the caller's client untouched. Anything else throws here,
 * while the component is being created, rather than rendering a tree whose
 * flags are all defaults.
 */
export function resolveClient(props: AvsbProviderProps): ResolvedClient {
  const injected = (props as { client?: SolidAvsbClient | null }).client
  if (injected !== undefined && injected !== null) {
    return { client: injected, owned: false }
  }

  const options = props as AvsbClientOptions
  if (typeof options.sdkKey !== 'string' || options.sdkKey.length === 0) {
    throw new Error(MISUSE_MESSAGE)
  }

  const clientOptions = clientOptionsFrom(props)
  // Report @avsbhq/solid on the heartbeat, not @avsbhq/browser (N1-14).
  return {
    client: new AvsbClient({
      ...clientOptions,
      wrapper: clientOptions.wrapper ?? { sdkType: SDK_TYPE, sdkVersion: SDK_VERSION },
    }),
    owned: true,
  }
}

/**
 * Every prop except `children`, copied WITHOUT reading `children`.
 *
 * N1-3 (production QA 2026-10-01): this used to be
 * `const { children, ...clientOptions } = props`. Solid compiles JSX children
 * to a lazy GETTER on `props`, and object rest reads every own property, so
 * the destructuring ran the getter and created the child components right
 * here, before `<AvsbContext.Provider>` existed. The README quick-start
 * (Mode A) therefore threw "the flag accessors must be called inside
 * <AvsbProvider>" on mount. Reading each key by name, skipping `children`,
 * leaves the getter untouched until the provider renders it.
 */
export function clientOptionsFrom(props: AvsbProviderProps): AvsbClientOptions {
  const source = props as unknown as Record<string, unknown>
  const options: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    if (key === 'children') continue
    options[key] = source[key]
  }
  return options as unknown as AvsbClientOptions
}
