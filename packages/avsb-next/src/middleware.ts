// App Router middleware.
//
// THE BUG THIS FILE EXISTS TO KILL (report 03 §5 Next, breaking change
// B8): `avsbNextAppMiddleware` returned `new Response(null, {status: 200})`
// for every matched request. In Next.js that IS the response, so the
// documented catch-all matcher blanked the entire site. It is deleted, not
// repaired: the replacement is a wrapper around YOUR middleware, which is
// the shape Next.js users expect and the only shape that can compose.

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import type { EvalContext } from '@avsbhq/core'
import {
  withNextRequest,
  nextAppHandler,
} from '@avsbhq/utils/middleware/nextApp'
import type {
  NextAppAvsbServer,
  NextAppMiddlewareOptions,
} from '@avsbhq/utils/middleware/nextApp'
import { resolveAnonCookieOptions, resolveAnonId } from './anonCookie'
import type { AnonCookieOptions } from './anonCookie'

export type { NextAppAvsbServer, NextAppMiddlewareOptions }
export { withNextRequest, nextAppHandler }

/** What your middleware may return. Next.js accepts all of these. */
export type MiddlewareResult = Response | undefined | null | void

/** Your middleware, sync or async. */
export type NextMiddleware = (
  request: NextRequest,
) => MiddlewareResult | Promise<MiddlewareResult>

export interface WithAvsbOptions {
  /**
   * A server client (`@avsbhq/node`). Pass it with `contextFrom` to open a
   * request-scoped evaluation scope that `getRequestClient()` can read.
   *
   * Worth knowing: that scope covers the middleware chain, route handlers,
   * and server actions in the same runtime. It does NOT reach React Server
   * Component renders, which Next.js runs separately. For RSCs, evaluate
   * with `evaluateFlagServer` or let `<AvsbRoot>` do it.
   */
  server?: NextAppAvsbServer
  /** Maps a request to an evaluation context. Return undefined to skip. */
  contextFrom?: (request: NextRequest) => EvalContext | undefined
  /** Record decisions for this request. Off by default. */
  withDecisionLog?: boolean
  /**
   * Anonymous visitor cookie. Set `cookie: false` to turn the cookie off
   * entirely, which also turns off server and client bucketing parity for
   * anonymous visitors.
   */
  cookie?: AnonCookieOptions | false
}

/**
 * Wrap your Next.js middleware so A vs B works end to end.
 *
 * ```ts
 * // middleware.ts
 * import { withAvsb } from '@avsbhq/next/middleware'
 *
 * export const middleware = withAvsb()
 *
 * export const config = { matcher: ['/((?!_next|.*\\..*).*)'] }
 * ```
 *
 * With your own middleware, and a server client for request-scoped
 * evaluation:
 *
 * ```ts
 * import { NextResponse } from 'next/server'
 * import type { NextRequest } from 'next/server'
 * import { withAvsb } from '@avsbhq/next/middleware'
 * import { server } from './lib/avsbServer'
 *
 * export const middleware = withAvsb(
 *   (request: NextRequest) => {
 *     if (request.nextUrl.pathname === '/old') {
 *       return NextResponse.redirect(new URL('/new', request.url))
 *     }
 *     return undefined
 *   },
 *   {
 *     server,
 *     contextFrom: (request: NextRequest) => ({
 *       kind: 'user',
 *       key: request.cookies.get('uid')?.value ?? 'anon',
 *     }),
 *   },
 * )
 * ```
 *
 * What the wrapper guarantees:
 *
 * - Your middleware's return value is passed through untouched. Return
 *   nothing and the request continues, exactly like `NextResponse.next()`.
 *   Nothing here can blank a page.
 * - The anonymous visitor cookie is maintained on whatever response goes
 *   out, including redirects, so the server and the browser evaluate the
 *   same visitor.
 * - With `server` and `contextFrom`, the request runs inside an evaluation
 *   scope, so `getRequestClient()` from `@avsbhq/utils` works downstream
 *   without threading a client through every call.
 */
export function withAvsb(
  middleware?: NextMiddleware,
  options?: WithAvsbOptions,
): (request: NextRequest) => Promise<Response> {
  const cookieOptions = options?.cookie === false ? null : resolveAnonCookieOptions(options?.cookie)

  return async (request: NextRequest): Promise<Response> => {
    const run = async (): Promise<Response> => {
      const result = middleware ? await middleware(request) : undefined
      // No response means "carry on", which in Next.js is NextResponse.next().
      return result ?? NextResponse.next()
    }

    const response = await runInScope(request, options, run)

    if (cookieOptions) {
      const existing = request.cookies.get(cookieOptions.name)?.value
      const { id, isNew } = resolveAnonId(existing)
      if (isNew) {
        // `Response` from a plain fetch handler has no cookies helper, so
        // only set it where Next gives us one. A user returning a bare
        // Response is opting out of the cookie for that request.
        const withCookies = response as { cookies?: { set: (init: Record<string, unknown>) => void } }
        withCookies.cookies?.set({
          name: cookieOptions.name,
          value: id,
          maxAge: cookieOptions.maxAge,
          path: cookieOptions.path,
          sameSite: cookieOptions.sameSite,
          secure: cookieOptions.secure,
          httpOnly: cookieOptions.httpOnly,
          ...(cookieOptions.domain ? { domain: cookieOptions.domain } : {}),
        })
      }
    }

    return response
  }
}

function runInScope(
  request: NextRequest,
  options: WithAvsbOptions | undefined,
  run: () => Promise<Response>,
): Promise<Response> {
  const server = options?.server
  const contextFrom = options?.contextFrom
  if (!server || !contextFrom) return run()

  return withNextRequest(
    server,
    {
      contextFrom: (raw: Request) => contextFrom(raw as NextRequest),
      ...(options?.withDecisionLog ? { withDecisionLog: true } : {}),
    },
    request,
    run,
  )
}
