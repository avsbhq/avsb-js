/**
 * The browser client's options, built once per request (server) and once per
 * page load (browser).
 *
 * The server branch is the interesting one. `AvsbClient` is a browser client:
 * during server rendering it must not start a poll loop, must not read or
 * write a cache it has no storage for, and must not open a stream that the
 * response will outlive. It gets the datafile that was already fetched for
 * this request and nothing else, so every server-rendered flag is answered
 * from memory, synchronously, and the client object is discarded with the
 * request.
 */
import type { AvsbClientOptions } from '@avsbhq/browser';
import type { EvalContext, FlagDatafile } from '@avsbhq/core';
import { SDK_TYPE, SDK_VERSION } from './version';

/**
 * The subset of `AvsbClientOptions` an app can set in `nuxt.config`: the
 * fields that survive the trip through `runtimeConfig` as JSON. Derived from
 * the real type with `Pick`, so it cannot drift from the SDK.
 *
 * `logger`, `onError` and `events` are absent on purpose. The first two are
 * functions, which `runtimeConfig` cannot carry; the third is a nested bag
 * that belongs to apps building their own client rather than to a config file.
 */
export type AvsbClientRuntimeOptions = Pick<
  AvsbClientOptions,
  | 'pollingInterval'
  | 'autoRefresh'
  | 'cdnHost'
  | 'initTimeout'
  | 'cache'
  | 'cacheMaxAgeMs'
  | 'adoptSnippetVisitorId'
  | 'pauseWhenHidden'
  | 'refetchOnFocus'
  | 'maxPendingEvents'
  | 'streaming'
  | 'streamingEndpoint'
  | 'logLevel'
>;

export interface BuildAvsbClientOptionsInput {
  /** The environment's SDK key. The caller guarantees it is non-empty. */
  sdkKey: string;
  /** True while rendering on the server. */
  isServer: boolean;
  /** The datafile fetched for this request, when there is one. */
  bootstrap?: FlagDatafile | null;
  /** Who this render is for. Null means the anonymous, persisted visitor. */
  context?: EvalContext | null;
  /** Whatever the app set under `avsb.client` in nuxt.config. */
  client?: AvsbClientRuntimeOptions;
  /** CDN base from the module options, used when `client.cdnHost` is not set. */
  cdnHost?: string;
}

/**
 * Build the options for one `AvsbClient`.
 *
 * `sdkKey` is applied after the app's own bag on purpose, and the server
 * switches after that: an app cannot accidentally override the key, or turn
 * polling back on during server rendering, through `avsb.client`.
 */
export function buildAvsbClientOptions(input: BuildAvsbClientOptionsInput): AvsbClientOptions {
  const base: AvsbClientOptions = {
    ...(input.client ?? {}),
    ...(input.cdnHost !== undefined && input.client?.cdnHost === undefined
      ? { cdnHost: input.cdnHost }
      : {}),
    sdkKey: input.sdkKey,
    // The heartbeat names @avsbhq/nuxt, not the vue or browser package
    // underneath it (N1-14).
    wrapper: { sdkType: SDK_TYPE, sdkVersion: SDK_VERSION },
    ...(input.bootstrap ? { bootstrap: input.bootstrap } : {}),
    ...(input.context ? { context: input.context } : {}),
  };

  if (!input.isServer) return base;

  return {
    ...base,
    // No network, no timers, no storage during server rendering.
    autoInit: false,
    autoRefresh: false,
    cache: false,
    streaming: false,
  };
}
