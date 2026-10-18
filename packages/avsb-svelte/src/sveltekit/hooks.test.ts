/**
 * SvelteKit server helpers.
 *
 * The load-bearing assertion is the serialisation round-trip: what
 * `getAvsbBootstrap` returns has to survive JSON and then be accepted by the
 * browser client's `bootstrap` option. The previous helper returned a map of
 * evaluated flags, which crashed the constructor, and no test caught it
 * because nothing fed the output back into a client.
 */
import { describe, it, expect, vi } from 'vitest'
import { AvsbClient } from '@avsbhq/browser'
import { createFlag } from '@avsbhq/core'
import type { EvalContext, Flag, FlagDatafile } from '@avsbhq/core'
import { createTestDatafile } from '../testing'
import {
  bindAvsbClient,
  getAvsbBootstrap,
  withAvsbHooks,
  type AvsbBoundClient,
  type AvsbLocals,
  type AvsbServerClient,
  type Handle,
  type RequestEvent,
} from './hooks'

const USER: EvalContext = { kind: 'user', key: 'u_1' }

function boundClient(): AvsbBoundClient {
  const on = createFlag<boolean>({
    value: true,
    variationKey: 'on',
    source: 'rule',
    ruleId: 'r1',
    ruleType: 'ab_test',
    reasons: [],
  })
  return {
    getFlag: <T,>(_key: string, defaultValue: T): Flag<T> =>
      createFlag<T>({
        value: defaultValue,
        variationKey: null,
        source: 'not_found',
        ruleId: null,
        ruleType: null,
        reasons: [],
      }),
    getBoolFlag: () => on,
    getStringFlag: (_key: string, defaultValue: string) =>
      createFlag<string>({
        value: defaultValue,
        variationKey: null,
        source: 'not_found',
        ruleId: null,
        ruleType: null,
        reasons: [],
      }),
    getNumberFlag: (_key: string, defaultValue: number) =>
      createFlag<number>({
        value: defaultValue,
        variationKey: null,
        source: 'not_found',
        ruleId: null,
        ruleType: null,
        reasons: [],
      }),
    getJsonFlag: <T,>(_key: string, defaultValue: T): Flag<T> =>
      createFlag<T>({
        value: defaultValue,
        variationKey: null,
        source: 'not_found',
        ruleId: null,
        ruleType: null,
        reasons: [],
      }),
    getAllFlags: (): Record<string, Flag> => ({ 'checkout-v2': on }),
    manualExposure: vi.fn(),
    getContext: () => USER,
  }
}

function serverClient(datafile: FlagDatafile | null): AvsbServerClient {
  return {
    forUser: () => boundClient(),
    getDatafile: () => datafile,
  }
}

/**
 * SvelteKit's `RequestEvent` has a dozen members (fetch, params, route,
 * platform, setHeaders, isDataRequest…) that these helpers never touch, so a
 * test builds the four they do read and widens once, here, rather than
 * pretending the helpers accept a looser shape than SvelteKit hands them.
 */
function makeEvent(): RequestEvent {
  return {
    request: new Request('https://example.com/'),
    url: new URL('https://example.com/'),
    cookies: { get: () => undefined },
    locals: {},
  } as unknown as RequestEvent
}

function localsOf(event: RequestEvent): Record<string, unknown> {
  return event.locals as Record<string, unknown>
}

describe('withAvsbHooks', () => {
  it('puts the context, a bound client, and the datafile on locals.avsb', async () => {
    const datafile = createTestDatafile({ 'checkout-v2': true })
    const handle: Handle = ({ event, resolve }) => resolve(event)
    const wrapped = withAvsbHooks(handle, {
      serverClient: serverClient(datafile),
      resolveContext: () => USER,
    })
    const event = makeEvent()

    await wrapped({ event, resolve: () => new Response('ok') })

    const locals = localsOf(event)['avsb'] as AvsbLocals
    expect(locals.evalContext).toEqual(USER)
    expect(locals.bootstrap).toBe(datafile)
    expect(locals.client.getBoolFlag('checkout-v2', false).value).toBe(true)
  })

  it('skips the request entirely when resolveContext returns null', async () => {
    const wrapped = withAvsbHooks(({ event, resolve }) => resolve(event), {
      serverClient: serverClient(createTestDatafile({})),
      resolveContext: () => null,
    })
    const event = makeEvent()

    await wrapped({ event, resolve: () => new Response('ok') })

    expect(localsOf(event)['avsb']).toBeUndefined()
  })

  it('carries a null bootstrap when the server client has no datafile yet', async () => {
    const wrapped = withAvsbHooks(({ event, resolve }) => resolve(event), {
      serverClient: serverClient(null),
      resolveContext: () => USER,
    })
    const event = makeEvent()

    await wrapped({ event, resolve: () => new Response('ok') })

    expect((localsOf(event)['avsb'] as AvsbLocals).bootstrap).toBeNull()
  })

  it('returns the inner handle response untouched', async () => {
    const wrapped = withAvsbHooks(() => new Response('inner', { status: 201 }), {
      serverClient: serverClient(null),
      resolveContext: () => USER,
    })

    const response = await wrapped({
      event: makeEvent(),
      resolve: () => new Response('outer'),
    })

    expect(response.status).toBe(201)
    expect(await response.text()).toBe('inner')
  })

  it('calls the inner handle exactly once', async () => {
    const handle = vi.fn(() => new Response('ok'))
    const wrapped = withAvsbHooks(handle, {
      serverClient: serverClient(null),
      resolveContext: () => USER,
    })

    await wrapped({ event: makeEvent(), resolve: () => new Response('ok') })

    expect(handle).toHaveBeenCalledTimes(1)
  })
})

describe('getAvsbBootstrap', () => {
  it('round-trips through JSON and is accepted by the browser client', () => {
    const datafile = createTestDatafile({ 'checkout-v2': true })
    const bootstrap = getAvsbBootstrap(serverClient(datafile))
    expect(bootstrap).not.toBeNull()

    // Exactly what a +layout.server.ts load returns and +layout.svelte hands
    // to <AvsbProvider bootstrap={...}>.
    const serialised = JSON.parse(JSON.stringify(bootstrap)) as FlagDatafile

    const client = new AvsbClient({
      sdkKey: 'sdk_test_0000000000000000000',
      bootstrap: serialised,
      autoInit: false,
      autoRefresh: false,
      cache: false,
      logLevel: 'silent',
    })

    expect(client.isReady()).toBe(true)
    expect(client.getBoolFlag('checkout-v2', false, { readOnly: true }).value).toBe(
      true
    )
  })

  it('is null when the server client has not loaded a datafile', () => {
    expect(getAvsbBootstrap(serverClient(null))).toBeNull()
  })
})

describe('bindAvsbClient', () => {
  it('binds one context for the whole request', () => {
    const bound = bindAvsbClient(serverClient(null), USER)
    expect(bound.getContext()).toEqual(USER)
  })
})
