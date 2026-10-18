'use client'

// The client provider. Everything it knows comes from the server: the
// datafile, the evaluated values, and the context they were evaluated for.

import { useMemo, type ReactElement, type ReactNode } from 'react'
import { AvsbProvider } from '@avsbhq/react'
import type { SerializedFlagMap } from '@avsbhq/react'
import type { AvsbClientOptions } from '@avsbhq/browser'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'
import type { AvsbBootstrapBlob } from './AvsbHydrator'
import { AVSB_BOOTSTRAP_ID } from './AvsbHydrator'
import { SDK_TYPE, SDK_VERSION } from './version'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AvsbNextProviderProps
  extends Omit<AvsbClientOptions, 'sdkKey' | 'context' | 'bootstrap'> {
  /**
   * The environment SDK key. Required, so the client can refresh the
   * datafile after hydration and keep polling for publishes.
   */
  sdkKey: string
  /**
   * The context the server evaluated for. Passing it is what makes server
   * and client bucket the same visitor into the same variation.
   */
  context?: EvalContext
  /**
   * The datafile, so the browser never fetches it on first paint.
   * `<AvsbRoot>` fills this in.
   */
  bootstrap?: FlagDatafile
  /**
   * Values the server already evaluated. Feeds every hook's server
   * snapshot, so the server-rendered HTML and the hydration render show
   * the same thing.
   */
  serverFlags?: SerializedFlagMap
  children: ReactNode
}

// ---------------------------------------------------------------------------
// Bootstrap blob reader
// ---------------------------------------------------------------------------

/**
 * Read the blob `<AvsbHydrator>` wrote, if there is one.
 *
 * Exported for tests, and for anyone wiring a provider by hand.
 * Returns null on the server (there is no document) and on anything that
 * is not one of our blobs.
 */
export function readBootstrapBlob(): AvsbBootstrapBlob | null {
  if (typeof document === 'undefined') return null

  const fromGlobal = (globalThis as { __AVSB_BOOTSTRAP__?: unknown }).__AVSB_BOOTSTRAP__
  const parsedGlobal = coerceBlob(fromGlobal)
  if (parsedGlobal) return parsedGlobal

  const element = document.getElementById(AVSB_BOOTSTRAP_ID)
  if (!element?.textContent) return null
  return coerceBlob(element.textContent)
}

function coerceBlob(raw: unknown): AvsbBootstrapBlob | null {
  if (typeof raw === 'string') {
    try {
      return coerceBlob(JSON.parse(raw))
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as { format?: unknown }
  // The format marker is the whole validation: a blob with the wrong
  // marker is somebody else's script tag, not a truncated one of ours.
  if (candidate.format !== 'avsb-bootstrap-v1') return null
  return raw as AvsbBootstrapBlob
}

/**
 * The context a blob was evaluated for.
 *
 * Prefers the full context the hydrator embeds. Falls back to rebuilding
 * `{kind, key}` from the summary, which is all older blobs carry. The
 * rebuild is lossy (no targeting attributes), which is exactly why the
 * full context is embedded now.
 */
export function contextFromBlob(blob: AvsbBootstrapBlob | null): EvalContext | undefined {
  if (!blob) return undefined
  if (blob.context) return blob.context
  const first = blob.snapshot?.contextSummary?.[0]
  if (!first) return undefined
  return { kind: first.kind, key: first.key }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Mount the browser SDK for a Next.js app, bootstrapped from the server.
 *
 * Re-exported as `AvsbProvider` from `@avsbhq/next`, so consumers import
 * one name. Most apps never render it directly: `<AvsbRoot>` does.
 *
 * ```tsx
 * // app/providers.tsx
 * 'use client'
 * import { AvsbProvider } from '@avsbhq/next'
 *
 * export function Providers({ children }: { children: React.ReactNode }) {
 *   return (
 *     <AvsbProvider sdkKey={process.env.NEXT_PUBLIC_AVSB_SDK_KEY ?? ''}>
 *       {children}
 *     </AvsbProvider>
 *   )
 * }
 * ```
 *
 * Where each piece comes from, in order of precedence:
 *
 * 1. Props. What `<AvsbRoot>` passes. This is the only channel that also
 *    fixes the SERVER render, because props exist during SSR and a script
 *    tag in the DOM does not.
 * 2. The bootstrap blob, when `<AvsbHydrator>` put one in the page. It
 *    removes the client's first fetch, and carries the full context.
 * 3. Nothing: the client fetches the datafile itself and evaluates against
 *    its own persisted anonymous id.
 */
export function AvsbNextProvider({
  sdkKey,
  context,
  bootstrap,
  serverFlags,
  children,
  ...clientOptions
}: AvsbNextProviderProps): ReactElement {
  // Read once per mount. The blob never changes for the life of a page.
  const blob = useMemo(() => readBootstrapBlob(), [])

  const resolvedContext = context ?? contextFromBlob(blob)
  const resolvedBootstrap = bootstrap ?? blob?.datafile

  return (
    <AvsbProvider
      sdkKey={sdkKey}
      {...clientOptions}
      // The heartbeat names @avsbhq/next, not the react or browser package
      // underneath it (N1-14).
      wrapper={clientOptions.wrapper ?? { sdkType: SDK_TYPE, sdkVersion: SDK_VERSION }}
      {...(resolvedContext ? { context: resolvedContext } : {})}
      {...(resolvedBootstrap ? { bootstrap: resolvedBootstrap } : {})}
      {...(serverFlags ? { serverFlags } : {})}
    >
      {children}
    </AvsbProvider>
  )
}
