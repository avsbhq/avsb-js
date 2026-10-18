// AWS Lambda handler middleware. Wraps a handler so the ALS scope opens
// for the duration of one invocation. Compatible with Middy via the
// `before`/`after` hooks the wrapped handler exposes.

import type { EvalContext } from '@avsbhq/core'
import { requestContextStorage } from '../request'
import type { RequestBoundClient } from '../request'
import { createDecisionLog } from './_decisionLog'

interface LambdaEvent {
  [key: string]: unknown
}
interface LambdaContext {
  [key: string]: unknown
}

export interface LambdaAvsbServer {
  forUser(ctx: EvalContext): RequestBoundClient
}

export interface LambdaMiddlewareOptions<TEvent extends LambdaEvent = LambdaEvent> {
  contextFrom(event: TEvent): EvalContext | undefined
  withDecisionLog?: boolean
}

export function lambdaHandler<
  TEvent extends LambdaEvent,
  TResult,
>(
  server: LambdaAvsbServer,
  opts: LambdaMiddlewareOptions<TEvent>,
  handler: (event: TEvent, context: LambdaContext) => Promise<TResult>
): (event: TEvent, context: LambdaContext) => Promise<TResult> {
  return async (event, ctx) => {
    const evalCtx = opts.contextFrom(event)
    if (!evalCtx) return handler(event, ctx)
    const decisionLog = opts.withDecisionLog ? createDecisionLog() : null
    const client = server.forUser(evalCtx)
    return requestContextStorage.run(
      { context: evalCtx, client, decisionLog },
      () => handler(event, ctx)
    )
  }
}
