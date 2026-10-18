import { describe, expect, it, vi } from 'vitest'
import type { EvalContext, Flag, TrackPayload } from '@avsbhq/core'
import { notFoundFlag } from '@avsbhq/core'
import {
  getRequestClient,
  getRequestContext,
  getRequestDecisionLog,
} from '../request'
import { expressMiddleware } from './express'
import { honoMiddleware } from './hono'
import { koaMiddleware } from './koa'
import { lambdaHandler } from './lambda'
import { nextAppHandler, withNextRequest } from './nextApp'
import { nextPagesApi } from './nextPages'
import { workersHandler } from './workers'
import { fastifyPlugin } from './fastify'

// A stand-in for `server.forUser(ctx)`. It implements the whole
// RequestBoundClient surface on purpose: that surface is what
// `getRequestClient()` hands a caller, so a fake that only carried
// getFlag/track would let the middlewares compile against a narrower
// contract than real consumers use.
function makeServer() {
  return {
    forUser(ctx: EvalContext) {
      const miss = <T,>(key: string, def: T): Flag<T> =>
        notFoundFlag(def, `no datafile for ${key}`)
      return {
        getFlag: miss,
        getBoolFlag: (key: string, def: boolean) => miss(key, def),
        getStringFlag: (key: string, def: string) => miss(key, def),
        getNumberFlag: (key: string, def: number) => miss(key, def),
        getJsonFlag: <T,>(key: string, def: T) => miss(key, def),
        getAllFlags: (): Record<string, Flag> => ({}),
        track: (_eventKey: string, _payload?: TrackPayload) => undefined,
        _ctx: ctx,
      }
    },
  }
}

describe('expressMiddleware', () => {
  it('opens an ALS scope and decorates req.avsb', async () => {
    const server = makeServer()
    const mw = expressMiddleware(server, {
      contextFrom: () => ({ kind: 'user', key: 'u_1' }),
    })
    const req: Record<string, unknown> = {}
    await new Promise<void>((resolve) => {
      mw(req, {}, () => {
        expect(getRequestClient()).not.toBeNull()
        expect(getRequestContext()?.key).toBe('u_1')
        expect(req.avsb).toBeDefined()
        resolve()
      })
    })
  })

  it('passes through when contextFrom returns undefined', async () => {
    const mw = expressMiddleware(makeServer(), {
      contextFrom: () => undefined,
    })
    await new Promise<void>((resolve) => {
      mw({}, {}, () => {
        expect(getRequestClient()).toBeNull()
        resolve()
      })
    })
  })

  it('attaches a decision log when withDecisionLog is true', async () => {
    const mw = expressMiddleware(makeServer(), {
      contextFrom: () => ({ kind: 'user', key: 'u_1' }),
      withDecisionLog: true,
    })
    await new Promise<void>((resolve) => {
      mw({}, {}, () => {
        expect(getRequestDecisionLog()).not.toBeNull()
        resolve()
      })
    })
  })
})

describe('fastifyPlugin', () => {
  it('registers an onRequest hook that opens the scope', async () => {
    const hooks: Array<(req: unknown, _r: unknown, done: () => void) => void> = []
    const fastify = {
      addHook: vi.fn((_name: string, hook) => hooks.push(hook)),
      decorateRequest: vi.fn(),
    }
    fastifyPlugin(
      fastify,
      {
        server: makeServer(),
        contextFrom: () => ({ kind: 'user', key: 'u_1' }),
      },
      () => undefined
    )
    expect(hooks.length).toBe(1)
    await new Promise<void>((resolve) => {
      hooks[0]({}, {}, () => {
        expect(getRequestClient()).not.toBeNull()
        resolve()
      })
    })
  })
})

describe('honoMiddleware', () => {
  it('decorates c.set("avsb", client) and opens the scope', async () => {
    const mw = honoMiddleware(makeServer(), {
      contextFrom: () => ({ kind: 'user', key: 'u_1' }),
    })
    const sets = new Map<string, unknown>()
    const c = {
      req: { raw: new Request('https://x') },
      set: (k: string, v: unknown) => sets.set(k, v),
    }
    await mw(c, async () => {
      expect(getRequestClient()).not.toBeNull()
    })
    expect(sets.get('avsb')).toBeDefined()
  })
})

describe('koaMiddleware', () => {
  it('opens the ALS scope around next()', async () => {
    const mw = koaMiddleware(makeServer(), {
      contextFrom: () => ({ kind: 'user', key: 'u_1' }),
    })
    const ctx: Record<string, unknown> = {}
    await mw(ctx, async () => {
      expect(getRequestClient()).not.toBeNull()
    })
    expect(ctx.avsb).toBeDefined()
  })
})

describe('nextAppHandler + withNextRequest', () => {
  it('wraps the handler in an ALS scope', async () => {
    const handler = nextAppHandler(
      makeServer(),
      { contextFrom: () => ({ kind: 'user', key: 'u_1' }) },
      async () => {
        expect(getRequestClient()).not.toBeNull()
        return 'ok'
      }
    )
    expect(await handler(new Request('https://x'))).toBe('ok')
  })

  it('withNextRequest skips the scope when no context produced', async () => {
    const result = await withNextRequest(
      makeServer(),
      { contextFrom: () => undefined },
      new Request('https://x'),
      async () => 'ok'
    )
    expect(result).toBe('ok')
    expect(getRequestClient()).toBeNull()
  })
})

describe('nextPagesApi', () => {
  it('opens the scope for the wrapped handler', async () => {
    const wrapped = nextPagesApi(
      makeServer(),
      { contextFrom: () => ({ kind: 'user', key: 'u_1' }) },
      async (_req, _res) => {
        expect(getRequestClient()).not.toBeNull()
      }
    )
    await wrapped({ headers: {} }, {})
  })
})

describe('lambdaHandler', () => {
  it('wraps the handler in an ALS scope', async () => {
    const wrapped = lambdaHandler(
      makeServer(),
      { contextFrom: () => ({ kind: 'user', key: 'u_1' }) },
      async () => {
        expect(getRequestClient()).not.toBeNull()
        return { statusCode: 200 }
      }
    )
    const res = await wrapped({} as Record<string, unknown>, {} as Record<string, unknown>)
    expect(res.statusCode).toBe(200)
  })
})

describe('workersHandler', () => {
  it('runs the handler with the scope when AsyncLocalStorage is available', async () => {
    const wrapped = workersHandler(
      makeServer(),
      { contextFrom: () => ({ kind: 'user', key: 'u_1' }) },
      async () => new Response('ok')
    )
    const res = await wrapped(new Request('https://x'), {}, {
      waitUntil: () => undefined,
    })
    expect(res.status).toBe(200)
  })
})
