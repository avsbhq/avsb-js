// Koa request-scoped middleware.

import type { EvalContext } from '@avsbhq/core'
import { requestContextStorage } from '../request'
import type { RequestBoundClient } from '../request'
import { createDecisionLog } from './_decisionLog'

interface KoaContextLike {
  [key: string]: unknown
}
type KoaNext = () => Promise<void>

export interface KoaAvsbServer {
  forUser(ctx: EvalContext): RequestBoundClient
}

export interface KoaMiddlewareOptions {
  contextFrom(ctx: KoaContextLike): EvalContext | undefined
  withDecisionLog?: boolean
}

export function koaMiddleware(
  server: KoaAvsbServer,
  opts: KoaMiddlewareOptions
) {
  return async (ctx: KoaContextLike, next: KoaNext): Promise<void> => {
    const evalCtx = opts.contextFrom(ctx)
    if (!evalCtx) {
      await next()
      return
    }
    const decisionLog = opts.withDecisionLog ? createDecisionLog() : null
    const client = server.forUser(evalCtx)
    ;(ctx as Record<string, unknown>).avsb = client
    await requestContextStorage.run(
      { context: evalCtx, client, decisionLog },
      async () => {
        await next()
      }
    )
  }
}
