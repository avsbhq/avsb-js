/**
 * SolidStart server helpers.
 *
 * Two things are pinned here because both were fiction before:
 * `locals.avsbBootstrap` is actually populated, and what it carries survives
 * JSON and is accepted by the browser client's `bootstrap` option. The old
 * helper cast a map of evaluated flags to `FlagDatafile`, which crashed the
 * constructor, and set the local to null unconditionally.
 */
import { describe, it, expect, vi } from 'vitest'
import { AvsbClient } from '@avsbhq/browser'
import { createFlag } from '@avsbhq/core'
import type { EvalContext, Flag, FlagDatafile } from '@avsbhq/core'
import { createTestDatafile } from '../testFixtures'
import {
  getAvsbBootstrap,
  withAvsbServerContext,
  type AvsbBoundClient,
  type AvsbServerClient,
  type AvsbServerLocals,
  type SolidStartEvent,
} from './handler'

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
  const fallback = <T,>(defaultValue: T): Flag<T> =>
    createFlag<T>({
      value: defaultValue,
      variationKey: null,
      source: 'not_found',
      ruleId: null,
      ruleType: null,
      reasons: [],
    })

  return {
    getFlag: <T,>(_key: string, defaultValue: T): Flag<T> => fallback(defaultValue),
    getBoolFlag: () => on,
    getStringFlag: (_key: string, defaultValue: string) => fallback(defaultValue),
    getNumberFlag: (_key: string, defaultValue: number) => fallback(defaultValue),
    getJsonFlag: <T,>(_key: string, defaultValue: T): Flag<T> =>
      fallback(defaultValue),
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

function makeEvent(): SolidStartEvent {
  return { locals: {}, request: new Request('https://example.com/') }
}

describe('withAvsbServerContext', () => {
  it('populates avsbContext, avsbClient, and avsbBootstrap', async () => {
    const datafile = createTestDatafile({ 'checkout-v2': true })
    const middleware = withAvsbServerContext(() => {}, {
      serverClient: serverClient(datafile),
      resolveContext: () => USER,
    })
    const event = makeEvent()

    await middleware(event)

    const locals = event.locals as unknown as AvsbServerLocals
    expect(locals.avsbContext).toEqual(USER)
    expect(locals.avsbBootstrap).toBe(datafile)
    expect(locals.avsbClient?.getBoolFlag('checkout-v2', false).value).toBe(true)
  })

  it('leaves every local null when resolveContext returns null', async () => {
    const middleware = withAvsbServerContext(() => {}, {
      serverClient: serverClient(createTestDatafile({})),
      resolveContext: () => null,
    })
    const event = makeEvent()

    await middleware(event)

    expect(event.locals).toEqual({
      avsbContext: null,
      avsbClient: null,
      avsbBootstrap: null,
    })
  })

  it('carries a null bootstrap when the server client has no datafile yet', async () => {
    const middleware = withAvsbServerContext(() => {}, {
      serverClient: serverClient(null),
      resolveContext: () => USER,
    })
    const event = makeEvent()

    await middleware(event)

    expect((event.locals as unknown as AvsbServerLocals).avsbBootstrap).toBeNull()
  })

  it('calls the inner handler exactly once, with the same event', async () => {
    const inner = vi.fn()
    const middleware = withAvsbServerContext(inner, {
      serverClient: serverClient(null),
      resolveContext: () => USER,
    })
    const event = makeEvent()

    await middleware(event)

    expect(inner).toHaveBeenCalledTimes(1)
    expect(inner).toHaveBeenCalledWith(event)
  })

  it('passes a response the inner handler produced straight back', async () => {
    const answered = new Response('inner', { status: 201 })
    const middleware = withAvsbServerContext(() => answered, {
      serverClient: serverClient(null),
      resolveContext: () => USER,
    })

    const returned = await middleware(makeEvent())

    expect(returned).toBe(answered)
  })

  it('returns nothing when the inner handler passes the request through', async () => {
    const middleware = withAvsbServerContext(() => {}, {
      serverClient: serverClient(null),
      resolveContext: () => USER,
    })

    expect(await middleware(makeEvent())).toBeUndefined()
  })
})

describe('getAvsbBootstrap', () => {
  it('round-trips through JSON and is accepted by the browser client', () => {
    const datafile = createTestDatafile({ 'checkout-v2': true })
    const bootstrap = getAvsbBootstrap(serverClient(datafile))
    expect(bootstrap).not.toBeNull()

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
    expect(
      client.getBoolFlag('checkout-v2', false, { readOnly: true }).value
    ).toBe(true)
  })

  it('is null when the server client has not loaded a datafile', () => {
    expect(getAvsbBootstrap(serverClient(null))).toBeNull()
  })
})
