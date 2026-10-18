/**
 * SvelteKit server helpers.
 *
 * Two things happen per request:
 *
 * 1. `withAvsbHooks` binds your server client to the request's context and
 *    puts it on `event.locals.avsb`, so any `load` function or endpoint can
 *    read flags without threading identity around.
 * 2. `getAvsbBootstrap` hands back the DATAFILE, which is exactly what
 *    `<AvsbProvider bootstrap={...}>` takes. That is the whole SSR story:
 *    the browser client starts ready, the first paint has real values, and
 *    nothing is fetched on the critical path.
 *
 * The previous version of this file serialised a map of evaluated flags and
 * told you to pass it as `bootstrap`, which crashed the browser client: it
 * expects a datafile and iterates `datafile.flags`. Server-evaluated VALUES
 * are a separate handoff that the browser SDK does not expose publicly yet.
 *
 * `src/hooks.server.ts`:
 *
 *   import { AvsbServer } from '@avsbhq/node'
 *   import { withAvsbHooks } from '@avsbhq/svelte/sveltekit'
 *   import type { Handle } from '@sveltejs/kit'
 *
 *   const avsb = new AvsbServer({ sdkKey: AVSB_SDK_KEY })
 *
 *   export const handle: Handle = withAvsbHooks(
 *     ({ event, resolve }) => resolve(event),
 *     {
 *       serverClient: avsb,
 *       resolveContext: (event) => ({
 *         kind: 'user',
 *         key: event.cookies.get('uid') ?? 'anonymous',
 *       }),
 *     }
 *   )
 *
 * `src/routes/+layout.server.ts`:
 *
 *   import type { LayoutServerLoad } from './$types'
 *
 *   export const load: LayoutServerLoad = ({ locals }) => ({
 *     avsbBootstrap: locals.avsb.bootstrap,
 *     newCheckout: locals.avsb.client.getBoolFlag('new-checkout-flow', false).value,
 *   })
 *
 * `src/routes/+layout.svelte`:
 *
 *   <AvsbProvider sdkKey={PUBLIC_AVSB_SDK_KEY} bootstrap={data.avsbBootstrap}>
 *     {@render children()}
 *   </AvsbProvider>
 */

import type { Handle, RequestEvent } from '@sveltejs/kit'
import type { AvsbFlagKey, DecideOption, DecisionLog, EvalContext, Flag, FlagDatafile } from '@avsbhq/core'

// SvelteKit's own `Handle` and `RequestEvent`, imported as TYPES only: this
// entry point is the SvelteKit one, `@sveltejs/kit` is already an optional
// peer plus a devDependency, and nothing here emits a runtime import, so a
// non-SvelteKit app that never touches `@avsbhq/svelte/sveltekit` is
// unaffected. Reproducing the shapes locally (what this file used to do) did
// not survive contact with the real ones: kit's `RequestEvent` is an
// interface with no index signature, so it never satisfied a
// `[key: string]: unknown` target, and the two `resolve` signatures failed
// `strictFunctionTypes` in both directions. The result was a helper whose own
// documented example could not compile without a cast.
export type { Handle, RequestEvent }

// ---------------------------------------------------------------------------
// The slice of @avsbhq/node these helpers use.
//
// `AvsbServer` satisfies `AvsbServerClient`, and the `UserBoundClient` its
// `forUser` returns satisfies `AvsbBoundClient`, so nothing is cast.
// ---------------------------------------------------------------------------

/**
 * Per-evaluation options, mirroring `ServerGetFlagOptions` in @avsbhq/node.
 *
 * Declared structurally rather than imported: this package depends on
 * @avsbhq/core and @avsbhq/browser, not on the server SDK.
 */
export interface AvsbBoundReadOptions {
  /** Per-call decide options, e.g. `[DecideOption.DISABLE_EXPOSURE]`. */
  decideOptions?: DecideOption[]
  /** Append this evaluation to a decision log. */
  decisionLog?: DecisionLog
}

/** Mirrors `GetAllFlagsOptions` in @avsbhq/node. */
export interface AvsbBoundAllFlagsOptions extends AvsbBoundReadOptions {
  /** Record an exposure for every flag evaluated. Default false. */
  fireExposures?: boolean
}

/**
 * A per-request client with the visitor's context already bound.
 *
 * The options argument is optional everywhere and changes nothing about an
 * existing call. It exists because a server evaluation DOES record an exposure
 * by default, so deferring one (`DISABLE_EXPOSURE` now, `manualExposure` where
 * the visitor sees the variation) has to be expressible through this type.
 */
export interface AvsbBoundClient {
  getFlag<T>(flagKey: AvsbFlagKey, defaultValue: T, options?: AvsbBoundReadOptions): Flag<T>
  getBoolFlag(flagKey: AvsbFlagKey, defaultValue: boolean, options?: AvsbBoundReadOptions): Flag<boolean>
  getStringFlag(flagKey: AvsbFlagKey, defaultValue: string, options?: AvsbBoundReadOptions): Flag<string>
  getNumberFlag(flagKey: AvsbFlagKey, defaultValue: number, options?: AvsbBoundReadOptions): Flag<number>
  getJsonFlag<T>(flagKey: AvsbFlagKey, defaultValue: T, options?: AvsbBoundReadOptions): Flag<T>
  getAllFlags(options?: AvsbBoundAllFlagsOptions): Record<string, Flag>
  /** Record that the visitor was shown this decision (server-side render). */
  manualExposure(flagKey: AvsbFlagKey): void
  getContext(): EvalContext
}

/** The server SDK: bind a context per request, and expose the datafile. */
export interface AvsbServerClient {
  forUser(context: EvalContext): AvsbBoundClient
  getDatafile(): FlagDatafile | null
}

// ---------------------------------------------------------------------------
// What lands on event.locals
// ---------------------------------------------------------------------------

/**
 * Declare this in `src/app.d.ts`:
 *
 *   declare global {
 *     namespace App {
 *       interface Locals {
 *         avsb?: import('@avsbhq/svelte/sveltekit').AvsbLocals
 *       }
 *     }
 *   }
 *
 * OPTIONAL, deliberately: when `resolveContext` returns null the wrapper sets
 * no locals at all, so a `load` function that runs on a skipped request would
 * otherwise read `undefined` through a type that promised it could not be.
 * Declare it required only if your `resolveContext` never returns null.
 */
export interface AvsbLocals {
  /** The context this request was evaluated for. */
  evalContext: EvalContext
  /** Flag reads bound to that context. */
  client: AvsbBoundClient
  /**
   * The datafile, ready to serialise into the page and hand to
   * `<AvsbProvider bootstrap={...}>`. Null when the server client has not
   * loaded one yet, in which case the browser fetches its own.
   */
  bootstrap: FlagDatafile | null
}

export interface WithAvsbHooksOptions {
  /** Your `AvsbServer` instance from @avsbhq/node. */
  serverClient: AvsbServerClient
  /**
   * Build the evaluation context for this request. Return null to skip A vs B
   * entirely (static assets, health checks): `locals.avsb` is then not set.
   */
  resolveContext: (event: RequestEvent) => EvalContext | null
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** Bind a server client to one request context. */
export function bindAvsbClient(
  serverClient: AvsbServerClient,
  context: EvalContext
): AvsbBoundClient {
  return serverClient.forUser(context)
}

/**
 * The datafile to hand `<AvsbProvider bootstrap={...}>`.
 *
 * JSON-safe by construction: it is the same document the CDN serves.
 * Returns null when the server client has not loaded one yet (its first
 * request, or a failed fetch), and the browser client then fetches its own.
 */
export function getAvsbBootstrap(
  serverClient: AvsbServerClient
): FlagDatafile | null {
  return serverClient.getDatafile()
}

/**
 * Wrap a SvelteKit `Handle` so every request carries `locals.avsb`.
 *
 * The inner handle is called exactly once, with the same event, so this
 * composes with other wrappers in either order.
 */
export function withAvsbHooks(
  handle: Handle,
  options: WithAvsbHooksOptions
): Handle {
  return ({ event, resolve }) => {
    const evalContext = options.resolveContext(event)

    if (evalContext !== null) {
      const locals: AvsbLocals = {
        evalContext,
        client: bindAvsbClient(options.serverClient, evalContext),
        bootstrap: getAvsbBootstrap(options.serverClient),
      }
      // `App.Locals` is empty until an app augments it, so this package
      // cannot see its own key on the real type. Widening only the write
      // keeps the public signature on SvelteKit's own `Handle`.
      ;(event.locals as Record<string, unknown>)['avsb'] = locals
    }

    return handle({ event, resolve })
  }
}
