// Express request-scoped middleware. Opens an AsyncLocalStorage scope per
// request so deeply nested code can `getRequestClient()` without threading
// the user context through every signature.

import type { EvalContext } from '@avsbhq/core'
import { requestContextStorage } from '../request'
import type { RequestBoundClient } from '../request'
import { createDecisionLog } from './_decisionLog'

interface ExpressLikeRequest {
  [key: string]: unknown
}
interface ExpressLikeResponse {
  [key: string]: unknown
}
type NextFn = (err?: unknown) => void

export interface ExpressAvsbServer {
  forUser(ctx: EvalContext): RequestBoundClient
}

export interface ExpressMiddlewareOptions {
  contextFrom(req: ExpressLikeRequest): EvalContext | undefined
  withDecisionLog?: boolean
}

export function expressMiddleware(
  server: ExpressAvsbServer,
  opts: ExpressMiddlewareOptions
) {
  return (req: ExpressLikeRequest, _res: ExpressLikeResponse, next: NextFn) => {
    const ctx = opts.contextFrom(req)
    if (!ctx) {
      next()
      return
    }
    const decisionLog = opts.withDecisionLog ? createDecisionLog() : null
    const client = server.forUser(ctx)
    ;(req as Record<string, unknown>).avsb = client
    requestContextStorage.run(
      { context: ctx, client, decisionLog },
      () => next()
    )
  }
}
