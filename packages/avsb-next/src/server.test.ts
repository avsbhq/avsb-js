/**
 * `<AvsbRoot>`, tested at the function level.
 *
 * It is an async Server Component, so the test calls it and inspects the
 * element tree it returns: which props reach the client provider, and what
 * happens when the datafile cannot be fetched. Nothing renders markup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactElement } from 'react'
import { AvsbRoot } from './server'
import { AvsbNextProvider } from './AvsbNextProvider'
import { AvsbHydrator } from './AvsbHydrator'
import { AVSB_ANON_COOKIE } from './anonCookie'
import type { AvsbNextProviderProps } from './AvsbNextProvider'
import type { AvsbHydratorProps } from './AvsbHydrator'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'

const SDK_KEY = 'sdk_production_avsbroot00000'

const cookieStore = {
  get: vi.fn<(name: string) => { value: string } | undefined>(),
  set: vi.fn(),
  delete: vi.fn(),
}

vi.mock('next/headers', () => ({
  cookies: () => cookieStore,
  headers: () => new Headers(),
}))

function datafile(): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
    publishedAt: '2026-01-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.test.invalid',
    audiences: [],
    flags: [
      {
        id: 'f1',
        key: 'checkout_v2',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'v_on',
        variations: [{ id: 'v_on', key: 'on', value: true }],
        overrides: [],
        rules: [],
      },
    ],
  }
}

type Child = ReactElement<Record<string, unknown>> | null

function childrenOf(element: ReactElement): Child[] {
  const props = element.props as { children?: Child[] }
  return props.children ?? []
}

function providerProps(element: ReactElement): AvsbNextProviderProps {
  const child = childrenOf(element).find((entry) => entry?.type === AvsbNextProvider)
  if (!child) throw new Error('AvsbRoot did not render the client provider')
  return child.props as unknown as AvsbNextProviderProps
}

function hydratorProps(element: ReactElement): AvsbHydratorProps | null {
  const child = childrenOf(element).find((entry) => entry?.type === AvsbHydrator)
  return child ? (child.props as unknown as AvsbHydratorProps) : null
}

beforeEach(() => {
  cookieStore.get.mockReset()
  cookieStore.set.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(datafile()) }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AvsbRoot', () => {
  it('hands the client provider the datafile and the server-evaluated values', async () => {
    const element = await AvsbRoot({ sdkKey: SDK_KEY, children: null })
    const props = providerProps(element)

    expect(props.sdkKey).toBe(SDK_KEY)
    expect(props.bootstrap?.sdkKey).toBe(SDK_KEY)
    // These are what make server HTML show real values instead of defaults.
    expect(props.serverFlags?.['checkout_v2']?.value).toBe(true)
    expect(props.serverFlags?.['checkout_v2']?.source).toBe('default')
  })

  it('evaluates for the visitor in the cookie, so server and client agree', async () => {
    const existing = 'anon_11111111-2222-3333-4444-555555555555'
    cookieStore.get.mockReturnValue({ value: existing })

    const element = await AvsbRoot({ sdkKey: SDK_KEY, children: null })
    const props = providerProps(element)

    expect(props.context).toEqual({ kind: 'user', key: existing })
    // The same key reaches the browser client, which is the parity fix.
    expect(cookieStore.set).not.toHaveBeenCalled()
  })

  it('mints and writes a visitor id when the cookie is missing', async () => {
    cookieStore.get.mockReturnValue(undefined)

    const element = await AvsbRoot({ sdkKey: SDK_KEY, children: null })
    const props = providerProps(element)

    expect(cookieStore.set).toHaveBeenCalledOnce()
    const written = cookieStore.set.mock.calls[0][0] as { name: string; value: string }
    expect(written.name).toBe(AVSB_ANON_COOKIE)
    expect((props.context as { key: string }).key).toBe(written.value)
  })

  it('prefers an explicit context over the anonymous cookie', async () => {
    const context: EvalContext = { kind: 'user', key: 'u_42', plan: 'pro' }

    const element = await AvsbRoot({ sdkKey: SDK_KEY, context, children: null })

    expect(providerProps(element).context).toEqual(context)
  })

  it('writes the blob without a second copy of the datafile', async () => {
    const element = await AvsbRoot({ sdkKey: SDK_KEY, children: null })
    const hydrator = hydratorProps(element)

    expect(hydrator).not.toBeNull()
    // The datafile travels as a provider prop; duplicating it into the
    // blob would ship every byte of it twice.
    expect(hydrator?.includeDatafile).toBe(false)
  })

  it('omits the blob when asked to', async () => {
    const element = await AvsbRoot({
      sdkKey: SDK_KEY,
      emitBootstrapScript: false,
      children: null,
    })

    expect(hydratorProps(element)).toBeNull()
  })

  it('still renders the provider when the datafile cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    const element = await AvsbRoot({ sdkKey: SDK_KEY, children: null })
    const props = providerProps(element)

    // Degrade to defaults, never to a blank page.
    expect(props.sdkKey).toBe(SDK_KEY)
    expect(props.bootstrap).toBeUndefined()
    expect(props.serverFlags).toBeUndefined()
    expect(hydratorProps(element)).toBeNull()
  })

  it('names the fix when no SDK key can be resolved', async () => {
    const previous = { app: process.env.AVSB_SDK_KEY, pub: process.env.NEXT_PUBLIC_AVSB_SDK_KEY }
    delete process.env.AVSB_SDK_KEY
    delete process.env.NEXT_PUBLIC_AVSB_SDK_KEY

    await expect(AvsbRoot({ children: null })).rejects.toThrow(/AVSB_SDK_KEY/)
    await expect(AvsbRoot({ children: null })).rejects.toThrow(/Environments in the project sidebar/)

    if (previous.app) process.env.AVSB_SDK_KEY = previous.app
    if (previous.pub) process.env.NEXT_PUBLIC_AVSB_SDK_KEY = previous.pub
  })

  it('reads the key from the environment when none is passed', async () => {
    process.env.AVSB_SDK_KEY = SDK_KEY

    const element = await AvsbRoot({ children: null })

    expect(providerProps(element).sdkKey).toBe(SDK_KEY)
    delete process.env.AVSB_SDK_KEY
  })
})
