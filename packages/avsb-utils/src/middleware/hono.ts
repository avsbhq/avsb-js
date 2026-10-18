// Hono request-scoped middleware. Hono runs on every modern JS runtime
// (Workers, Bun, Deno, Node); the ALS scope opens on Node only and
// degrades to direct context injection on edge runtimes via c.set('avsb').

import type { EvalContext } from '@avsbhq/core'
import { requestContextStorage } from '../request'
import type { RequestBoundClient } from '../request'
import { createDecisionLog } from './_decisionLog'

interface HonoContextLike {
  req: { raw: Request }
  set(key: string, value: unknown): void
}
type HonoNext = () => Promise<void>

export interface HonoAvsbServer {
  forUser(ctx: EvalContext): RequestBoundClient
}

export interface HonoMiddlewareOptions {
  contextFrom(c: HonoContextLike): EvalContext | undefined
  withDecisionLog?: boolean
}

export function honoMiddleware(
  server: HonoAvsbServer,
  opts: HonoMiddlewareOptions
) {
  return async (c: HonoContextLike, next: HonoNext): Promise<void> => {
    const ctx = opts.contextFrom(c)
    if (!ctx) {
      await next()
      return
    }
    const decisionLog = opts.withDecisionLog ? createDecisionLog() : null
    const client = server.forUser(ctx)
    c.set('avsb', client)
    if (
      typeof (globalThis as { process?: unknown }).process !== 'undefined'
    ) {
      await requestContextStorage.run(
        { context: ctx, client, decisionLog },
        async () => {
          await next()
        }
      )
    } else {
      await next()
    }
  }
}
