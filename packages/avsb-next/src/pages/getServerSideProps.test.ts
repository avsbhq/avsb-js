/**
 * The Pages Router helper.
 *
 * It used to emit a `__avsbBootstrap` JSON string that no component could
 * consume: the provider had no prop for it and the README documented a
 * third shape entirely. The prop is now exactly the provider's props, so
 * `_app.tsx` is a spread.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getServerSideAvsb } from './getServerSideProps'
import type { GsspContext } from './getServerSideProps'
import { AVSB_ANON_COOKIE, isAnonId } from '../anonCookie'
import type { FlagDatafile } from '@avsbhq/core'

const SDK_KEY = 'sdk_production_pagesrouter00'
const USER_CTX = { kind: 'user' as const, key: 'user-1' }

function makeDatafile(): FlagDatafile {
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
        id: 'flag-banner',
        key: 'show-banner',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'var-off',
        variations: [
          { id: 'var-on', key: 'on', value: true },
          { id: 'var-off', key: 'off', value: false },
        ],
        overrides: [{ userId: 'user-1', variationId: 'var-on' }],
        rules: [],
      },
    ],
  }
}

function makeCtx(cookies: Record<string, string> = {}): GsspContext & {
  res: { setHeader: ReturnType<typeof vi.fn>; getHeader: ReturnType<typeof vi.fn> }
} {
  return {
    req: { headers: {}, cookies },
    res: { setHeader: vi.fn(), getHeader: vi.fn() },
    params: {},
    query: {},
  }
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(makeDatafile()) }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('getServerSideAvsb', () => {
  it('returns props the provider can be spread with', async () => {
    const gssp = getServerSideAvsb({ sdkKey: SDK_KEY, contextFrom: () => USER_CTX })

    const result = await gssp(makeCtx())

    expect(result.props.avsbBootstrap.sdkKey).toBe(SDK_KEY)
    expect(result.props.avsbBootstrap.context).toEqual(USER_CTX)
    expect(result.props.avsbBootstrap.bootstrap.sdkKey).toBe(SDK_KEY)
    expect(result.props.avsbBootstrap.serverFlags['show-banner']?.value).toBe(true)
  })

  it('is JSON-serialisable, which is what Next requires of page props', async () => {
    const gssp = getServerSideAvsb({ sdkKey: SDK_KEY, contextFrom: () => USER_CTX })

    const result = await gssp(makeCtx())

    expect(() => JSON.stringify(result.props)).not.toThrow()
    const roundTripped = JSON.parse(JSON.stringify(result.props))
    expect(roundTripped.avsbBootstrap.serverFlags['show-banner'].value).toBe(true)
  })

  it('gives the inner handler Flag objects, methods included', async () => {
    const gssp = getServerSideAvsb(
      { sdkKey: SDK_KEY, contextFrom: () => USER_CTX },
      async ({ flags, datafile, context, gsspCtx }) => {
        expect(datafile.sdkKey).toBe(SDK_KEY)
        expect(context).toEqual(USER_CTX)
        expect(gsspCtx.req.headers).toBeDefined()
        return { props: { showBanner: flags['show-banner']?.isEnabled() ?? false } }
      },
    )

    const result = await gssp(makeCtx())

    expect(result.props.showBanner).toBe(true)
    expect(result.props.avsbBootstrap).toBeDefined()
  })

  it('uses the anonymous visitor cookie when no contextFrom is given', async () => {
    const existing = 'anon_11111111-2222-3333-4444-555555555555'
    const gssp = getServerSideAvsb({ sdkKey: SDK_KEY })

    const ctx = makeCtx({ [AVSB_ANON_COOKIE]: existing })
    const result = await gssp(ctx)

    expect(result.props.avsbBootstrap.context).toEqual({ kind: 'user', key: existing })
    expect(ctx.res.setHeader).not.toHaveBeenCalled()
  })

  it('mints and sets the visitor cookie when the request has none', async () => {
    const gssp = getServerSideAvsb({ sdkKey: SDK_KEY })

    const ctx = makeCtx()
    const result = await gssp(ctx)

    expect(ctx.res.setHeader).toHaveBeenCalledOnce()
    const [name, value] = ctx.res.setHeader.mock.calls[0] as [string, string[]]
    expect(name).toBe('Set-Cookie')
    expect(value[0]).toContain(`${AVSB_ANON_COOKIE}=`)
    expect(isAnonId((result.props.avsbBootstrap.context as { key: string }).key)).toBe(true)
  })

  it('evaluates for the resolved context, not a default visitor', async () => {
    const gssp = getServerSideAvsb({
      sdkKey: SDK_KEY,
      contextFrom: () => ({ kind: 'user', key: 'somebody-else' }),
    })

    const result = await gssp(makeCtx())

    // The override targets user-1 only.
    expect(result.props.avsbBootstrap.serverFlags['show-banner']?.value).toBe(false)
  })
})
