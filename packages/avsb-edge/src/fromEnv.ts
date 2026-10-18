// =====================================================================
// Values an adapter resolves from the runtime's per-request environment.
//
// WHY THIS EXISTS: Cloudflare Workers expose secrets and bindings ONLY on
// the `env` argument of `fetch`. There is no module-scope access to them.
// So the adapter shape
//
//   createCloudflareHandler({ sdkKey: 'literal', kv: someKvBinding })
//
// could never be written by a real Worker author: at module scope `env`
// does not exist yet. The old adapter offered exactly that shape, which is
// why every README quickstart wrote `sdkKey: () => env.AVSB_SDK_KEY` and
// `kvNamespace: (env) => env.AVSB_KV` (edge README:37-38) against an API
// that did not accept functions. The docs were describing the API the
// platform requires; the code had the other one.
//
// Accepting `T | ((env) => T)` makes both spellings legal: a literal for
// Fastly and Bun where `env` is reachable at module scope, and a resolver
// for Cloudflare where it is not.
// =====================================================================

/** A value, or a function of the per-request environment that returns it. */
export type FromEnv<TEnv, TValue> = TValue | ((env: TEnv) => TValue)

/** Resolve a `FromEnv` against the environment for this request. */
export function resolveFromEnv<TEnv, TValue>(
  source: FromEnv<TEnv, TValue>,
  env: TEnv,
): TValue {
  return typeof source === 'function' ? (source as (e: TEnv) => TValue)(env) : source
}

/**
 * A value, or a thunk that produces it at first use.
 *
 * Fastly Compute forbids constructing platform resources (`new KVStore(...)`)
 * during global initialisation, so a Fastly binding has to be created inside
 * the request handler. This is that shape, for runtimes with no `env` object
 * to hang the resolver off.
 */
export type Lazy<TValue> = TValue | (() => TValue)

/** Resolve a `Lazy`, calling the thunk if that is what it is. */
export function resolveLazy<TValue>(source: Lazy<TValue>): TValue {
  return typeof source === 'function' ? (source as () => TValue)() : source
}
