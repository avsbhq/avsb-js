// One middleware home (breaking change B6).
//
// This package used to export its OWN `expressMiddleware(client, {userIdFrom})`
// while @avsbhq/utils exported `expressMiddleware(server, {contextFrom})`: same
// name, incompatible options. The node README documented the node export with
// the utils options, so the flagship integration example threw
// "config.userIdFrom is not a function" on the first request.
//
// These tests pin that the re-exported functions ARE the utils implementations
// (identity, not a lookalike) and that the contextFrom contract works through
// them against a real AvsbServer.

import { describe, expect, it, vi } from 'vitest'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'
import { expressMiddleware as utilsExpress } from '@avsbhq/utils/middleware/express'
import { fastifyPlugin as utilsFastify } from '@avsbhq/utils/middleware/fastify'
import { getRequestClient, getRequestContext } from '@avsbhq/utils'
import { AvsbServer, expressMiddleware, fastifyPlugin } from './index'

const DATAFILE: FlagDatafile = {
  version: 2,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk_production_middlewaretest01',
  environmentKey: 'production',
  publishedAt: '2026-05-28T00:00:00.000Z',
  collectEndpoint: 'https://collect.test',
  flags: [
    {
      id: 'flag1',
      key: 'checkout-v2',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var_off',
      variations: [
        { id: 'var_off', key: 'off', value: false },
        { id: 'var_on', key: 'on', value: true },
      ],
      overrides: [],
      rules: [
        {
          id: 'rule1',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: null,
          variations: [{ variationId: 'var_on', percentage: 1 }],
        },
      ],
    },
  ],
  audiences: [],
}

function makeServer(): AvsbServer {
  return new AvsbServer({
    sdkKey: DATAFILE.sdkKey,
    bootstrap: DATAFILE,
    streaming: false,
    logLevel: 'silent',
  })
}

describe('middleware exports', () => {
  it('re-exports the @avsbhq/utils implementations, not a second copy', () => {
    expect(expressMiddleware).toBe(utilsExpress)
    expect(fastifyPlugin).toBe(utilsFastify)
  })
})

describe('expressMiddleware through @avsbhq/node', () => {
  it('decorates req.avsb with a client bound to contextFrom(req)', async () => {
    const server = makeServer()
    await server.onReady()

    const middleware = expressMiddleware(server, {
      contextFrom: (req) => {
        const userId = (req as { userId?: string }).userId
        return userId ? ({ kind: 'user', key: userId } as EvalContext) : undefined
      },
    })

    const req: Record<string, unknown> = { userId: 'u_1' }
    await new Promise<void>((resolve) => {
      middleware(req, {}, () => {
        const bound = req.avsb as { getBoolFlag(k: string, d: boolean): { value: boolean } }
        expect(bound.getBoolFlag('checkout-v2', false).value).toBe(true)
        resolve()
      })
    })

    await server.close()
  })

  it('opens an AsyncLocalStorage scope so nested code can read the request client', async () => {
    const server = makeServer()
    await server.onReady()

    const middleware = expressMiddleware(server, {
      contextFrom: () => ({ kind: 'user', key: 'u_als' }),
    })

    await new Promise<void>((resolve) => {
      middleware({}, {}, () => {
        // The claim the README makes about `getRequestClient()`.
        const nested = getRequestClient()
        expect(nested).not.toBeNull()
        expect(nested?.getBoolFlag('checkout-v2', false).value).toBe(true)
        expect(getRequestContext()?.key).toBe('u_als')
        resolve()
      })
    })

    await server.close()
  })

  it('skips AvsB entirely when contextFrom returns undefined', async () => {
    const server = makeServer()
    await server.onReady()

    const next = vi.fn()
    const middleware = expressMiddleware(server, { contextFrom: () => undefined })
    const req: Record<string, unknown> = {}
    middleware(req, {}, next)

    expect(next).toHaveBeenCalledOnce()
    expect(req.avsb).toBeUndefined()
    expect(getRequestClient()).toBeNull()

    await server.close()
  })
})

describe('fastifyPlugin through @avsbhq/node', () => {
  it('registers an onRequest hook that binds request.avsb', async () => {
    const server = makeServer()
    await server.onReady()

    const hooks: Array<(req: unknown, reply: unknown, done: () => void) => void> = []
    const fastify = {
      addHook: vi.fn((_name: string, hook: (req: unknown, reply: unknown, done: () => void) => void) => {
        hooks.push(hook)
      }),
      decorateRequest: vi.fn(),
    }

    fastifyPlugin(
      fastify,
      { server, contextFrom: () => ({ kind: 'user', key: 'u_fastify' }) },
      () => undefined
    )

    expect(fastify.decorateRequest).toHaveBeenCalledWith('avsb', null)
    expect(hooks).toHaveLength(1)

    const request: Record<string, unknown> = {}
    await new Promise<void>((resolve) => {
      hooks[0](request, {}, () => {
        const bound = request.avsb as { getBoolFlag(k: string, d: boolean): { value: boolean } }
        expect(bound.getBoolFlag('checkout-v2', false).value).toBe(true)
        resolve()
      })
    })

    await server.close()
  })
})
