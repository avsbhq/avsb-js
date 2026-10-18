// Next.js Pages Router middleware adapter (API routes, getServerSideProps).

import type { EvalContext } from '@avsbhq/core'
import { requestContextStorage } from '../request'
import type { RequestBoundClient } from '../request'
import { createDecisionLog } from './_decisionLog'

interface PagesReq {
  headers: Record<string, string | string[] | undefined>
  cookies?: Record<string, string>
  url?: string
  [key: string]: unknown
}
interface PagesRes {
  [key: string]: unknown
}

export interface PagesAvsbServer {
  forUser(ctx: EvalContext): RequestBoundClient
}

export interface PagesMiddlewareOptions {
  contextFrom(req: PagesReq): EvalContext | undefined
  withDecisionLog?: boolean
}

export function nextPagesApi(
  server: PagesAvsbServer,
  opts: PagesMiddlewareOptions,
  handler: (req: PagesReq, res: PagesRes) => Promise<void> | void
) {
  return async (req: PagesReq, res: PagesRes): Promise<void> => {
    const ctx = opts.contextFrom(req)
    if (!ctx) {
      await handler(req, res)
      return
    }
    const decisionLog = opts.withDecisionLog ? createDecisionLog() : null
    const client = server.forUser(ctx)
    ;(req as Record<string, unknown>).avsb = client
    await requestContextStorage.run(
      { context: ctx, client, decisionLog },
      async () => {
        await handler(req, res)
      }
    )
  }
}
