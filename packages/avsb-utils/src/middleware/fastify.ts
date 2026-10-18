// Fastify request-scoped middleware (plugin). Opens an AsyncLocalStorage
// scope per request and decorates `request.avsb` with a per-user client.

import type { EvalContext } from '@avsbhq/core'
import { requestContextStorage } from '../request'
import type { RequestBoundClient } from '../request'
import { createDecisionLog } from './_decisionLog'

interface FastifyLikeRequest {
  [key: string]: unknown
}
interface FastifyLikeReply {
  [key: string]: unknown
}
interface FastifyLikeInstance {
  addHook(
    name: 'onRequest',
    hook: (
      request: FastifyLikeRequest,
      reply: FastifyLikeReply,
      done: (err?: Error) => void
    ) => void
  ): void
  decorateRequest(name: string, value: unknown): void
}

export interface FastifyAvsbServer {
  forUser(ctx: EvalContext): RequestBoundClient
}

export interface FastifyPluginOptions {
  server: FastifyAvsbServer
  contextFrom(req: FastifyLikeRequest): EvalContext | undefined
  withDecisionLog?: boolean
}

export function fastifyPlugin(
  fastify: FastifyLikeInstance,
  opts: FastifyPluginOptions,
  done: () => void
): void {
  fastify.decorateRequest('avsb', null)
  fastify.addHook('onRequest', (request, _reply, hookDone) => {
    const ctx = opts.contextFrom(request)
    if (!ctx) {
      hookDone()
      return
    }
    const decisionLog = opts.withDecisionLog ? createDecisionLog() : null
    const client = opts.server.forUser(ctx)
    ;(request as Record<string, unknown>).avsb = client
    requestContextStorage.run(
      { context: ctx, client, decisionLog },
      () => hookDone()
    )
  })
  done()
}
