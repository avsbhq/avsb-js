// Pages Router adapter.
//
// THE BUG THIS FILE EXISTS TO KILL (report 03 §5 Next): the old HOF
// produced a `__avsbBootstrap` JSON STRING prop that no component in the
// repo consumed, `AvsbProvider` had no prop that could accept it, and the
// README documented a third option shape that did not compile. The output
// is now exactly the props the client provider takes, so wiring it up is a
// spread.

import type { EvalContext, Flag, FlagDatafile } from '@avsbhq/core'
import type { SerializedFlagMap } from '@avsbhq/react'
import { getDatafile } from '../getDatafile'
import { evaluateFlagServer } from '../evaluateFlagServer'
import { evaluateServerFlags } from '../serverFlags'
import { resolveAnonCookieOptions, resolveAnonId } from '../anonCookie'
import type { AnonCookieOptions } from '../anonCookie'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The slice of Next's `GetServerSidePropsContext` this helper needs. */
export interface GsspContext {
  req: {
    headers: Record<string, string | string[] | undefined>
    cookies?: Record<string, string>
    url?: string
  }
  res?: {
    setHeader(name: string, value: string | string[]): void
    getHeader?(name: string): string | string[] | number | undefined
  }
  params?: Record<string, string | string[]>
  query?: Record<string, string | string[]>
  [key: string]: unknown
}

/** What the page's props carry, ready to spread into the provider. */
export interface AvsbPagesBootstrap {
  sdkKey: string
  context: EvalContext
  bootstrap: FlagDatafile
  serverFlags: SerializedFlagMap
}

/** What the inner handler receives. */
export interface AvsbGsspContext {
  datafile: FlagDatafile
  /** Evaluated flags as `Flag` objects, methods included, for server logic. */
  flags: Record<string, Flag>
  context: EvalContext
  gsspCtx: GsspContext
}

export interface GetServerSideAvsbOptions {
  /** The environment SDK key. */
  sdkKey: string
  /** CDN base URL. Default 'https://cdn.avsb.cloud'. */
  cdnHost?: string
  /**
   * Maps the request to an evaluation context. Omit it and the anonymous
   * visitor cookie is used, minted and set on the response when missing.
   */
  contextFrom?: (ctx: GsspContext) => EvalContext
  /** Anonymous cookie options, when `contextFrom` is omitted. */
  cookie?: AnonCookieOptions
}

export interface GsspResult<P extends Record<string, unknown>> {
  props: P & { avsbBootstrap: AvsbPagesBootstrap }
}

// ---------------------------------------------------------------------------
// HOF
// ---------------------------------------------------------------------------

/**
 * Fetch the datafile and evaluate every flag before your page renders.
 *
 * ```tsx
 * // pages/checkout.tsx
 * import { getServerSideAvsb } from '@avsbhq/next/pages'
 *
 * export const getServerSideProps = getServerSideAvsb({
 *   sdkKey: process.env.AVSB_SDK_KEY ?? '',
 * })
 * ```
 *
 * ```tsx
 * // pages/_app.tsx
 * import { AvsbProvider } from '@avsbhq/next'
 * import type { AppProps } from 'next/app'
 *
 * export default function App({ Component, pageProps }: AppProps) {
 *   const { avsbBootstrap, ...rest } = pageProps
 *   return (
 *     <AvsbProvider {...avsbBootstrap}>
 *       <Component {...rest} />
 *     </AvsbProvider>
 *   )
 * }
 * ```
 *
 * `props.avsbBootstrap` is exactly the provider's props: the SDK key, the
 * context that was evaluated, the datafile, and the evaluated values. The
 * page renders with real values on the server AND hydrates with them, and
 * the browser makes no datafile request before first paint.
 *
 * An inner handler still gets the evaluated flags as `Flag` objects, so
 * server-side branching reads the same way as in a component:
 *
 * ```ts
 * export const getServerSideProps = getServerSideAvsb(
 *   { sdkKey: process.env.AVSB_SDK_KEY ?? '' },
 *   async ({ flags }) => ({
 *     props: { showBanner: flags['show-banner']?.isEnabled() ?? false },
 *   }),
 * )
 * ```
 */
export function getServerSideAvsb<P extends Record<string, unknown> = Record<string, never>>(
  options: GetServerSideAvsbOptions,
  handler?: (avsbCtx: AvsbGsspContext) => Promise<{ props: P }>,
): (gsspCtx: GsspContext) => Promise<GsspResult<P>> {
  return async (gsspCtx: GsspContext): Promise<GsspResult<P>> => {
    const context = options.contextFrom
      ? options.contextFrom(gsspCtx)
      : anonymousContext(gsspCtx, options.cookie)

    const datafile = await getDatafile(options.sdkKey, { cdnHost: options.cdnHost })

    const flags: Record<string, Flag> = {}
    for (const entry of datafile.flags) {
      flags[entry.key] = evaluateFlagServer<null>(datafile, context, entry.key, null)
    }

    const avsbBootstrap: AvsbPagesBootstrap = {
      sdkKey: options.sdkKey,
      context,
      bootstrap: datafile,
      serverFlags: evaluateServerFlags(datafile, context),
    }

    if (handler) {
      const inner = await handler({ datafile, flags, context, gsspCtx })
      return { props: { ...inner.props, avsbBootstrap } }
    }

    return { props: { avsbBootstrap } as P & { avsbBootstrap: AvsbPagesBootstrap } }
  }
}

/**
 * The anonymous visitor for this request, minting and setting the cookie
 * when it is missing so the next request buckets the same way.
 */
function anonymousContext(
  gsspCtx: GsspContext,
  cookieOptions?: AnonCookieOptions,
): EvalContext {
  const attributes = resolveAnonCookieOptions(cookieOptions)
  const existing = gsspCtx.req.cookies?.[attributes.name]
  const { id, isNew } = resolveAnonId(existing)

  if (isNew && gsspCtx.res) {
    const parts = [
      `${attributes.name}=${id}`,
      `Path=${attributes.path}`,
      `Max-Age=${attributes.maxAge}`,
      `SameSite=${attributes.sameSite.charAt(0).toUpperCase()}${attributes.sameSite.slice(1)}`,
    ]
    if (attributes.secure) parts.push('Secure')
    if (attributes.domain) parts.push(`Domain=${attributes.domain}`)
    const existingHeader = gsspCtx.res.getHeader?.('Set-Cookie')
    const previous = Array.isArray(existingHeader)
      ? existingHeader
      : typeof existingHeader === 'string'
        ? [existingHeader]
        : []
    gsspCtx.res.setHeader('Set-Cookie', [...previous, parts.join('; ')])
  }

  return { kind: 'user', key: id }
}
