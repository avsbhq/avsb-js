// Server Component. Injects the bootstrap blob into the HTML so the
// browser SDK starts with real flag values and no CDN round trip.
//
// NO 'use client': this file must stay RSC-safe.

import type { ReactElement } from 'react'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'
import type { BootstrapBlob } from '@avsbhq/utils'
import { getDatafile } from './getDatafile'
import { evaluateServerFlags } from './serverFlags'

// ---------------------------------------------------------------------------
// The blob
// ---------------------------------------------------------------------------

/**
 * What `<AvsbHydrator>` writes into the page.
 *
 * A `BootstrapBlob` plus the FULL evaluation context. The base blob's
 * `contextSummary` carries only `{kind, key}` pairs, so a provider rebuilt
 * from it lost every targeting attribute the server had (report 03 §5:
 * "drops all context attributes, silently overriding the caller's
 * fallbackContext"). The extra field is additive and survives the JSON
 * round trip untouched.
 */
export interface AvsbBootstrapBlob extends BootstrapBlob {
  context?: EvalContext
}

/** The element id and the window global the client provider looks for. */
export const AVSB_BOOTSTRAP_ID = '__AVSB_BOOTSTRAP__'

/**
 * Serialise a blob for embedding inside `<script type="application/json">`.
 *
 * THE VULNERABILITY THIS CLOSES (report 03 §5, premise 3): the blob was
 * embedded with `dangerouslySetInnerHTML` and no escaping, under a comment
 * claiming JSON was safe there. It is not. A flag whose variation value
 * contains a script-closing payload ends the data block early and the rest
 * of it executes. Variation values are authored in the dashboard, so that
 * was stored XSS on every page of every customer using the hydrator,
 * reachable by any member of an org.
 *
 * Escaping every `<` as the JSON escape sequence closes it: `JSON.parse`
 * still yields `<`, so nothing downstream changes, and no literal `<`
 * survives in the HTML for the parser to act on. The two Unicode line
 * separators go with it: both are legal inside a JSON string but are line
 * terminators in JavaScript, so they break any consumer that evaluates the
 * blob rather than parsing it.
 */
export function serializeBootstrapBlob(blob: AvsbBootstrapBlob): string {
  return JSON.stringify(blob)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AvsbHydratorProps {
  /** Pre-fetched datafile. Pass either this or `sdkKey`. */
  datafile?: FlagDatafile
  /** SDK key used to fetch the datafile. Pass either this or `datafile`. */
  sdkKey?: string
  /** CDN base URL. Default 'https://cdn.avsb.cloud'. */
  cdnHost?: string
  /**
   * Evaluation context. Every flag in the datafile is evaluated for it,
   * and the context itself travels in the blob so the browser client
   * evaluates against the same attributes.
   */
  context: EvalContext
  /**
   * Embed the datafile in the blob. Default TRUE: the blob is the only
   * channel a standalone hydrator has, and without the datafile the
   * browser client fetches it again, which is the round trip this
   * component exists to remove.
   *
   * `<AvsbRoot>` passes false, because it hands the datafile to the
   * provider as a prop instead and one copy in the page is enough.
   */
  includeDatafile?: boolean
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Inject the bootstrap blob for a client `<AvsbProvider>` to read.
 *
 * Most apps should use `<AvsbRoot>` instead, which does this plus the
 * anonymous cookie plus the provider in one line. Reach for the hydrator
 * when the provider lives somewhere else in the tree entirely.
 *
 * ```tsx
 * // app/layout.tsx
 * import { AvsbHydrator } from '@avsbhq/next/server'
 *
 * export default async function RootLayout({
 *   children,
 * }: { children: React.ReactNode }) {
 *   const context = { kind: 'user' as const, key: 'anon' }
 *   return (
 *     <html>
 *       <body>
 *         <AvsbHydrator sdkKey={process.env.AVSB_SDK_KEY ?? ''} context={context} />
 *         {children}
 *       </body>
 *     </html>
 *   )
 * }
 * ```
 */
export async function AvsbHydrator({
  datafile: providedDatafile,
  sdkKey,
  cdnHost,
  context,
  includeDatafile = true,
}: AvsbHydratorProps): Promise<ReactElement> {
  if (!providedDatafile && !sdkKey) {
    throw new Error(
      '[avsb] <AvsbHydrator> needs either a `datafile` or an `sdkKey`. The key ' +
        'looks like "sdk_production_xxxxxxxx" and lives in Environments in the ' +
        'project sidebar, in the A vs B dashboard.',
    )
  }

  const datafile: FlagDatafile =
    providedDatafile ?? (await getDatafile(sdkKey as string, { cdnHost }))

  const blob: AvsbBootstrapBlob = {
    format: 'avsb-bootstrap-v1',
    snapshot: {
      capturedAt: Date.now(),
      datafileVersion: datafile.publishedAt,
      // The blob's flags are data, not `Flag` objects: JSON drops methods,
      // and the client rebuilds them.
      flags: evaluateServerFlags(datafile, context) as BootstrapBlob['snapshot']['flags'],
      contextSummary: buildContextSummary(context),
    },
    context,
    producedAt: Date.now(),
    ...(includeDatafile ? { datafile } : {}),
  }

  return (
    <script
      type="application/json"
      id={AVSB_BOOTSTRAP_ID}
      // A `type="application/json"` block is data, not code, and the
      // content is escaped by serializeBootstrapBlob so no `<` can end it
      // early. Both halves are required: escaping without the data type
      // still executes, and the data type without escaping is the stored
      // XSS this replaced.
      dangerouslySetInnerHTML={{ __html: serializeBootstrapBlob(blob) }}
    />
  )
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildContextSummary(
  context: EvalContext,
): Array<{ kind: string; key: string }> {
  if (context.kind === 'multi') {
    const entries: Array<{ kind: string; key: string }> = []
    for (const [key, value] of Object.entries(context)) {
      if (key === 'kind') continue
      if (!value || typeof value !== 'object') continue
      const sub = value as { kind: string; key: string }
      entries.push({ kind: sub.kind, key: sub.key })
    }
    return entries
  }
  return [{ kind: context.kind, key: (context as { kind: string; key: string }).key }]
}
