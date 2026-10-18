// The one-line setup. A Server Component that does the whole wiring:
// resolve the visitor, fetch the datafile, evaluate every flag, write the
// escaped bootstrap blob, and mount the client provider around your app.
//
// NO 'use client': this file must stay RSC-safe.

import type { ReactElement, ReactNode } from 'react'
import { cookies } from 'next/headers'
import { consoleLogger } from '@avsbhq/core'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'
import type { SerializedFlagMap } from '@avsbhq/react'
import { AvsbHydrator } from './AvsbHydrator'
import { AvsbNextProvider } from './AvsbNextProvider'
import { AVSB_ANON_COOKIE, resolveAnonCookieOptions, resolveAnonId } from './anonCookie'
import type { AnonCookieOptions } from './anonCookie'
import { getDatafile } from './getDatafile'
import { evaluateServerFlags } from './serverFlags'

export interface AvsbRootProps {
  /**
   * The environment SDK key. Defaults to `process.env.AVSB_SDK_KEY`, then
   * `process.env.NEXT_PUBLIC_AVSB_SDK_KEY`.
   *
   * The key reaches the browser either way (it is how the client refreshes
   * the datafile), and that is safe: an SDK key is scoped to one
   * environment and grants flag reads only.
   */
  sdkKey?: string
  /**
   * Who to evaluate for. Omit it and the anonymous visitor cookie is used,
   * so server and client bucket identically with no work from you. Pass it
   * once a user is signed in.
   */
  context?: EvalContext
  /** CDN base URL. Default 'https://cdn.avsb.cloud'. */
  cdnHost?: string
  /**
   * Seconds Next may reuse a fetched datafile before revalidating.
   * Default 60.
   */
  revalidate?: number
  /** Options for the anonymous visitor cookie (name, lifetime, domain). */
  cookie?: AnonCookieOptions
  /**
   * Also write the bootstrap blob into the HTML. Default true. It is what
   * lets a second provider, a debug tool, or a non-React reader see the
   * same values. The datafile is NOT duplicated into it: that travels as a
   * prop.
   */
  emitBootstrapScript?: boolean
  children: ReactNode
}

const logger = consoleLogger('warn')

let warnedAboutCookie = false

/**
 * Everything a Next.js app needs, in one component.
 *
 * ```tsx
 * // app/layout.tsx
 * import { AvsbRoot } from '@avsbhq/next/server'
 *
 * export default function RootLayout({
 *   children,
 * }: { children: React.ReactNode }) {
 *   return (
 *     <html>
 *       <body>
 *         <AvsbRoot>{children}</AvsbRoot>
 *       </body>
 *     </html>
 *   )
 * }
 * ```
 *
 * What that one line does:
 *
 * 1. Resolves the visitor from the `avsb_anon_id` cookie, so the server
 *    and the browser bucket the same person the same way.
 * 2. Fetches the datafile, deduplicated within the request and cached
 *    across requests for `revalidate` seconds.
 * 3. Evaluates every flag on the server, so the HTML your users receive
 *    already contains their variation instead of your default value.
 * 4. Serialises the result safely (no script-closing payload can escape).
 * 5. Mounts the client provider with the datafile in hand, so the browser
 *    makes no request before the first paint.
 *
 * A failed datafile fetch does not fail the page: the provider still
 * mounts, every read returns the default you passed, `useAvsbStatus()`
 * reports the error with the reason, and the client's own retry can still
 * rescue the session.
 *
 * Exposures are not fired by server evaluation. Call `useExposure(flagKey)`
 * in the client component that shows the variation.
 */
export async function AvsbRoot({
  sdkKey,
  context,
  cdnHost,
  revalidate,
  cookie,
  emitBootstrapScript = true,
  children,
}: AvsbRootProps): Promise<ReactElement> {
  const resolvedKey =
    sdkKey ?? process.env.AVSB_SDK_KEY ?? process.env.NEXT_PUBLIC_AVSB_SDK_KEY ?? ''

  if (!resolvedKey) {
    throw new Error(
      '[avsb] <AvsbRoot> has no SDK key. Set AVSB_SDK_KEY in your environment, ' +
        'or pass sdkKey directly. The key looks like "sdk_production_xxxxxxxx" ' +
        'and lives in Environments in the project sidebar, in the A vs B dashboard.',
    )
  }

  const evaluationContext = context ?? (await anonymousContext(cookie))

  let datafile: FlagDatafile | null = null
  try {
    datafile = await getDatafile(resolvedKey, { cdnHost, revalidate })
  } catch (error) {
    // Loud, and not fatal: the page renders, flags fall back to defaults,
    // and the client retries on its own schedule.
    logger.error(
      error instanceof Error
        ? error.message
        : `[avsb] the datafile could not be fetched for ${resolvedKey}`,
    )
  }

  const serverFlags: SerializedFlagMap | undefined = datafile
    ? evaluateServerFlags(datafile, evaluationContext)
    : undefined

  return (
    <>
      {emitBootstrapScript && datafile ? (
        <AvsbHydrator
          datafile={datafile}
          context={evaluationContext}
          // The datafile reaches the client as a prop below. Putting it in
          // the blob as well would ship every byte of it twice.
          includeDatafile={false}
        />
      ) : null}
      <AvsbNextProvider
        sdkKey={resolvedKey}
        context={evaluationContext}
        {...(datafile ? { bootstrap: datafile } : {})}
        {...(serverFlags ? { serverFlags } : {})}
        {...(cdnHost ? { cdnHost } : {})}
      >
        {children}
      </AvsbNextProvider>
    </>
  )
}

/**
 * The anonymous visitor for this request.
 *
 * Reads the cookie `withAvsb` middleware maintains. When there is none, a
 * fresh id is minted and used for BOTH the server evaluation and the
 * browser client, so this page view is at least self-consistent, and one
 * warning explains how to make it stable across visits.
 */
async function anonymousContext(options?: AnonCookieOptions): Promise<EvalContext> {
  const attributes = resolveAnonCookieOptions(options)
  const store = await cookies()
  const existing = store.get(attributes.name)?.value
  const { id, isNew } = resolveAnonId(existing)

  if (isNew) {
    try {
      // Allowed in a Server Action or a Route Handler, and a no-op error
      // during a render. Either way the id below is used for this request.
      store.set({
        name: attributes.name,
        value: id,
        maxAge: attributes.maxAge,
        path: attributes.path,
        sameSite: attributes.sameSite,
        secure: attributes.secure,
        httpOnly: attributes.httpOnly,
        ...(attributes.domain ? { domain: attributes.domain } : {}),
      })
    } catch {
      warnAboutMissingCookie(attributes.name)
    }
  }

  return { kind: 'user', key: id }
}

function warnAboutMissingCookie(cookieName: string): void {
  if (warnedAboutCookie) return
  warnedAboutCookie = true
  logger.warn(
    `[avsb] no ${cookieName} cookie was found, and a Server Component cannot set one, ` +
      'so this visitor gets a new anonymous id on every request and their results ' +
      'will not add up. Add the middleware that maintains it:\n' +
      "  // middleware.ts\n" +
      "  import { withAvsb } from '@avsbhq/next/middleware'\n" +
      '  export const middleware = withAvsb()\n' +
      "  export const config = { matcher: ['/((?!_next|.*\\\\..*).*)'] }",
  )
}

export { AVSB_ANON_COOKIE }
