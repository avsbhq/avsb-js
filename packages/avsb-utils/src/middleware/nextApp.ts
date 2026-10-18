// Next.js App Router middleware adapter. Opens an ALS scope around an
// arbitrary handler so RSCs, route handlers, server actions, and
// background jobs share the same per-request avsb scope.

import type { EvalContext } from '@avsbhq/core'
import { requestContextStorage } from '../request'
import type { RequestBoundClient } from '../request'
import { createDecisionLog } from './_decisionLog'

export interface NextAppAvsbServer {
  forUser(ctx: EvalContext): RequestBoundClient
}

export interface NextAppMiddlewareOptions {
  contextFrom(req: Request): EvalContext | undefined
  withDecisionLog?: boolean
}

export function withNextRequest<T>(
  server: NextAppAvsbServer,
  opts: NextAppMiddlewareOptions,
  req: Request,
  handler: () => Promise<T>
): Promise<T> {
  const ctx = opts.contextFrom(req)
  if (!ctx) return handler()
  const decisionLog = opts.withDecisionLog ? createDecisionLog() : null
  const client = server.forUser(ctx)
  return requestContextStorage.run(
    { context: ctx, client, decisionLog },
    handler
  )
}

/**
 * Convenience: wraps a route handler so every request opens the scope.
 *
 * ```ts
 * export const GET = nextAppHandler(server, { contextFrom: ... }, async (req) => {
 *   const flag = getRequestClient()!.getFlag('foo', false)
 *   return NextResponse.json({ foo: flag.value })
 * })
 * ```
 */
export function nextAppHandler<TArgs extends unknown[], TResult>(
  server: NextAppAvsbServer,
  opts: NextAppMiddlewareOptions,
  handler: (req: Request, ...rest: TArgs) => Promise<TResult>
): (req: Request, ...rest: TArgs) => Promise<TResult> {
  return (req: Request, ...rest: TArgs) =>
    withNextRequest(server, opts, req, () => handler(req, ...rest))
}
