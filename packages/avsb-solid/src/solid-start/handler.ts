/**
 * SolidStart server helpers.
 *
 * Two things happen per request:
 *
 * 1. `withAvsbServerContext` binds your server client to the request's
 *    context and puts it on `event.locals`, so any route or server function
 *    can read flags without threading identity around.
 * 2. `event.locals.avsbBootstrap` carries the DATAFILE, which is exactly what
 *    `<AvsbProvider bootstrap={...}>` takes. That is the whole SSR story: the
 *    browser client starts ready, the first paint has real values, and
 *    nothing is fetched on the critical path.
 *
 * The previous version accepted an `sdkKey` it never used, set
 * `locals.avsbBootstrap = null` with a comment promising that something else
 * would populate it (nothing did), and its `serializeAvsbBootstrap` cast a
 * map of evaluated flags to `FlagDatafile`, which crashed the browser client
 * at construction. Server-evaluated VALUES are a different handoff that the
 * browser SDK does not expose publicly yet.
 *
 * `src/middleware.ts`:
 *
 *   import { createMiddleware } from '@solidjs/start/middleware'
 *   import { AvsbServer } from '@avsbhq/node'
 *   import { withAvsbServerContext } from '@avsbhq/solid/solid-start'
 *
 *   const avsb = new AvsbServer({ sdkKey: process.env['AVSB_SDK_KEY'] ?? '' })
 *
 *   export default createMiddleware({
 *     onRequest: [
 *       withAvsbServerContext(() => {}, {
 *         serverClient: avsb,
 *         resolveContext: (event) => ({
 *           kind: 'user',
 *           key: event.request.headers.get('x-user-id') ?? 'anonymous',
 *         }),
 *       }),
 *     ],
 *   })
 *
 * The inner handler returns NOTHING here, on purpose. On the h3-family
 * runner SolidStart uses, an `onRequest` handler that returns a value is
 * taken as the response for that request, so `(event) => event` would
 * short-circuit the route it was meant to pass through. Return a `Response`
 * only when you really mean to answer the request yourself.
 */

import type { EvalContext, Flag, FlagDatafile } from '@avsbhq/core'

// ---------------------------------------------------------------------------
// The slice of @avsbhq/node these helpers use.
//
// `AvsbServer` satisfies `AvsbServerClient`, and the `UserBoundClient` its
// `forUser` returns satisfies `AvsbBoundClient`, so nothing is cast.
// ---------------------------------------------------------------------------

/** A per-request client with the visitor's context already bound. */
export interface AvsbBoundClient {
  getFlag<T>(flagKey: string, defaultValue: T): Flag<T>
  getBoolFlag(flagKey: string, defaultValue: boolean): Flag<boolean>
  getStringFlag(flagKey: string, defaultValue: string): Flag<string>
  getNumberFlag(flagKey: string, defaultValue: number): Flag<number>
  getJsonFlag<T>(flagKey: string, defaultValue: T): Flag<T>
  getAllFlags(): Record<string, Flag>
  /** Record that the visitor was shown this decision (server-side render). */
  manualExposure(flagKey: string): void
  getContext(): EvalContext
}

/** The server SDK: bind a context per request, and expose the datafile. */
export interface AvsbServerClient {
  forUser(context: EvalContext): AvsbBoundClient
  getDatafile(): FlagDatafile | null
}

/**
 * The shape of the SolidStart request event these helpers touch. A local
 * interface rather than an import, so `@solidjs/start` stays an optional
 * peer dependency.
 */
export interface SolidStartEvent {
  locals: Record<string, unknown>
  request: Request
}

/**
 * A middleware handler: it either passes the request through (returns
 * nothing) or answers it itself (returns a `Response`). The return type is
 * narrow on purpose, because on the runner underneath SolidStart ANY
 * returned value is treated as the response, so a handler that returned the
 * event by accident would swallow the route.
 */
export type SolidStartHandler = (
  event: SolidStartEvent
) => void | Response | Promise<void | Response>

/**
 * What lands on `event.locals`. Declare it in your app:
 *
 *   declare module '@solidjs/start/server' {
 *     interface RequestEventLocals extends AvsbServerLocals {}
 *   }
 */
export interface AvsbServerLocals {
  /** The context this request was evaluated for, or null when skipped. */
  avsbContext: EvalContext | null
  /** Flag reads bound to that context, or null when skipped. */
  avsbClient: AvsbBoundClient | null
  /**
   * The datafile, ready to serialise into the page and hand to
   * `<AvsbProvider bootstrap={...}>`. Null when the server client has not
   * loaded one yet, in which case the browser fetches its own.
   */
  avsbBootstrap: FlagDatafile | null
}

export interface AvsbServerContextOptions {
  /** Your `AvsbServer` instance from @avsbhq/node. */
  serverClient: AvsbServerClient
  /**
   * Build the evaluation context for this request. Return null to skip A vs B
   * entirely (static assets, health checks): the locals are then all null.
   */
  resolveContext: (event: SolidStartEvent) => EvalContext | null
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
 * Wrap a SolidStart middleware handler so every request carries the A vs B
 * locals. The inner handler is called exactly once, with the same event.
 */
export function withAvsbServerContext(
  handler: SolidStartHandler,
  options: AvsbServerContextOptions
): SolidStartHandler {
  return (event: SolidStartEvent) => {
    const context = options.resolveContext(event)

    const locals: AvsbServerLocals =
      context === null
        ? { avsbContext: null, avsbClient: null, avsbBootstrap: null }
        : {
            avsbContext: context,
            avsbClient: options.serverClient.forUser(context),
            avsbBootstrap: getAvsbBootstrap(options.serverClient),
          }

    Object.assign(event.locals, locals)

    return handler(event)
  }
}
