// Cloudflare Workers handler middleware. Workers do not expose
// AsyncLocalStorage by default (requires the `nodejs_compat` flag);
// this adapter opens the scope when available and falls back to
// per-request env binding otherwise.

import type { EvalContext } from '@avsbhq/core'
import { requestContextStorage } from '../request'
import type { RequestBoundClient } from '../request'
import { createDecisionLog } from './_decisionLog'

export interface WorkersAvsbServer {
  forUser(ctx: EvalContext): RequestBoundClient
}

export interface WorkersMiddlewareOptions {
  contextFrom(req: Request): EvalContext | undefined
  withDecisionLog?: boolean
}

export function workersHandler(
  server: WorkersAvsbServer,
  opts: WorkersMiddlewareOptions,
  handler: (
    req: Request,
    env: Record<string, unknown>,
    ctx: { waitUntil(p: Promise<unknown>): void }
  ) => Promise<Response>
) {
  return async (
    req: Request,
    env: Record<string, unknown>,
    ctx: { waitUntil(p: Promise<unknown>): void }
  ): Promise<Response> => {
    const evalCtx = opts.contextFrom(req)
    if (!evalCtx) return handler(req, env, ctx)
    const decisionLog = opts.withDecisionLog ? createDecisionLog() : null
    const client = server.forUser(evalCtx)
    ;(env as Record<string, unknown>).avsb = client
    if (
      typeof (globalThis as { process?: unknown }).process !== 'undefined'
    ) {
      return requestContextStorage.run(
        { context: evalCtx, client, decisionLog },
        () => handler(req, env, ctx)
      )
    }
    return handler(req, env, ctx)
  }
}
