// Snapshots + bootstrap helpers. Spec §6.2.
//
// A FlagSnapshot is a synchronous read of every flag's current value for a
// given context. Bootstrap blobs are FlagSnapshot+datafile-version pairs
// the server SDK pre-computes and serialises for SSR/edge handoff to the
// browser SDK.

import type { Flag, EvalContext, FlagDatafile, SingleContext } from '@avsbhq/core'
import { isMultiContext } from '@avsbhq/core'

export interface FlagSnapshot {
  /** ms-epoch when the snapshot was produced. */
  capturedAt: number
  /** Datafile publishedAt timestamp at capture time. */
  datafileVersion: string
  /** flagKey → frozen Flag<unknown>. */
  flags: Record<string, Flag>
  /** kind+key summary of the evaluation context. */
  contextSummary: Array<{ kind: string; key: string }>
}

export interface BootstrapBlob {
  /** Magic marker so the browser SDK rejects malformed blobs early. */
  format: 'avsb-bootstrap-v1'
  snapshot: FlagSnapshot
  /** Optional datafile sub-payload; when present the browser skips its own fetch. */
  datafile?: FlagDatafile
  /** ms-epoch of producer time, for clock-skew diagnostics. */
  producedAt: number
}

/**
 * Client surface required by the snapshot helpers. Both browser and server
 * `Avsb*` classes expose this slice.
 */
export interface SnapshotClient {
  getAllFlags(opts?: {
    context?: EvalContext
    fireExposures?: boolean
  }): Record<string, Flag>
  getDatafile?(): FlagDatafile | null
  refresh?(): Promise<void>
  getCurrentContext?(): EvalContext | null
}

export function snapshot(
  client: SnapshotClient,
  ctx?: EvalContext
): FlagSnapshot {
  const ctxToUse =
    ctx ?? client.getCurrentContext?.() ?? null
  const flags = client.getAllFlags(
    ctxToUse ? { context: ctxToUse, fireExposures: false } : { fireExposures: false }
  )
  const datafile = client.getDatafile?.()
  return {
    capturedAt: Date.now(),
    datafileVersion: datafile?.publishedAt ?? '',
    flags,
    contextSummary: ctxToUse ? summarise(ctxToUse) : [],
  }
}

export async function snapshotFresh(
  client: SnapshotClient,
  ctx?: EvalContext
): Promise<FlagSnapshot> {
  if (client.refresh) {
    await client.refresh()
  }
  return snapshot(client, ctx)
}

export async function refreshAndSnapshot(
  client: SnapshotClient,
  ctx?: EvalContext
): Promise<FlagSnapshot> {
  return snapshotFresh(client, ctx)
}

export async function serializeBootstrap(
  client: SnapshotClient,
  ctx?: EvalContext,
  opts?: { includeDatafile?: boolean }
): Promise<BootstrapBlob> {
  const snap = snapshot(client, ctx)
  const blob: BootstrapBlob = {
    format: 'avsb-bootstrap-v1',
    snapshot: snap,
    producedAt: Date.now(),
  }
  if (opts?.includeDatafile && client.getDatafile) {
    const df = client.getDatafile()
    if (df) blob.datafile = df
  }
  return blob
}

/**
 * Client surface required to hydrate from a bootstrap blob.
 *
 * A client may implement either hook, both, or (deliberately) only one:
 *
 * - `applyDatafile` adopts the full datafile and evaluates locally from then
 *   on. Both the browser client and the server client implement it.
 * - `applySnapshot` adopts pre-evaluated values for ONE context until a real
 *   datafile arrives. Only context-bound clients implement it; the server
 *   client deliberately does not, because a snapshot belongs to one request's
 *   context and the server serves many. Semantics are spelled out in
 *   ./snapshotStore.ts.
 */
export interface BootstrapTarget {
  applyDatafile?(df: FlagDatafile): void
  applySnapshot?(snap: FlagSnapshot): void
}

/** What `hydrateBootstrap` actually did, so a caller can log or assert it. */
export interface HydrateBootstrapResult {
  /** The blob carried a datafile and the client adopted it. */
  datafileApplied: boolean
  /** The client adopted the pre-evaluated snapshot. */
  snapshotApplied: boolean
  /** Flag keys the snapshot carried. */
  flagCount: number
}

/**
 * Hand a bootstrap blob to a client.
 *
 * Returns what was applied. THROWS when nothing could be, because the old
 * behaviour (return quietly) is what made the documented SSR handoff a no-op
 * for a whole release: the browser client implemented neither hook, so every
 * `hydrateBootstrap` call did exactly nothing and the page fetched the
 * datafile anyway (report 02 §5.6). A handoff that cannot happen is a
 * programming error, and it says so.
 */
export function hydrateBootstrap(
  client: BootstrapTarget,
  blob: BootstrapBlob
): HydrateBootstrapResult {
  if (!blob || blob.format !== 'avsb-bootstrap-v1') {
    throw new Error(
      `Invalid bootstrap blob: expected format 'avsb-bootstrap-v1', got ${
        (blob as { format?: string } | undefined)?.format ?? 'undefined'
      }`
    )
  }

  let datafileApplied = false
  let snapshotApplied = false

  if (blob.datafile && client.applyDatafile) {
    client.applyDatafile(blob.datafile)
    datafileApplied = true
  }
  if (client.applySnapshot) {
    client.applySnapshot(blob.snapshot)
    snapshotApplied = true
  }

  if (!datafileApplied && !snapshotApplied) {
    throw new Error(
      blob.datafile
        ? 'hydrateBootstrap could not apply the bootstrap blob: this client has ' +
          'no applyDatafile hook. Pass the datafile to the constructor instead ' +
          '(`bootstrap: blob.datafile`).'
        : 'hydrateBootstrap could not apply the bootstrap blob: it carries no ' +
          '"datafile" and this client does not adopt pre-evaluated snapshots. ' +
          'Serialize with `serializeBootstrap(client, ctx, { includeDatafile: true })` ' +
          'so the blob carries the datafile, or pass `bootstrap: blob.datafile` to ' +
          'the constructor. Server clients (@avsbhq/node) evaluate a different ' +
          'context per request, so they never adopt one context\'s snapshot values.'
    )
  }

  return {
    datafileApplied,
    snapshotApplied,
    flagCount: Object.keys(blob.snapshot?.flags ?? {}).length,
  }
}

export interface BootstrapFromUrlOptions {
  signal?: AbortSignal
  /** ms timeout, default 5000. */
  timeoutMs?: number
  /** HTTP headers (e.g. auth). */
  headers?: Record<string, string>
}

export async function bootstrapFromUrl(
  url: string,
  opts?: BootstrapFromUrlOptions
): Promise<FlagDatafile> {
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 5000)
  try {
    const res = await fetch(url, {
      signal: opts?.signal ?? ctrl.signal,
      headers: opts?.headers,
    })
    if (!res.ok) {
      throw new Error(`Bootstrap fetch failed: ${res.status} ${res.statusText}`)
    }
    return (await res.json()) as FlagDatafile
  } finally {
    clearTimeout(timeout)
  }
}

export interface KVNamespace {
  get(key: string): Promise<string | null>
}

export async function bootstrapFromKV(
  kv: KVNamespace,
  key: string
): Promise<FlagDatafile> {
  const raw = await kv.get(key)
  if (!raw) throw new Error(`Bootstrap KV miss for key '${key}'`)
  return JSON.parse(raw) as FlagDatafile
}

export async function bootstrapFromFile(path: string): Promise<FlagDatafile> {
  // The specifier is held in a variable instead of being written inline,
  // because a dynamic import with a LITERAL specifier is still resolved and
  // bundled: esbuild, webpack and Vite all follow `import('node:fs/promises')`
  // and a browser build then fails with "Could not resolve fs/promises". The
  // old comment here claimed the dynamic import kept fs out of browser
  // bundles; it did not, and it made every module reachable from this file
  // (including `createUtils`) impossible for a customer to bundle for the web.
  // A computed specifier is opaque to the bundler, so this stays a real
  // runtime import on the server and is simply never called in a browser,
  // where reading a file off disk is meaningless anyway.
  const specifier = 'node:fs/promises'
  const fs = (await import(
    /* webpackIgnore: true */ /* @vite-ignore */ specifier
  )) as typeof import('node:fs/promises')
  const raw = await fs.readFile(path, 'utf-8')
  return JSON.parse(raw) as FlagDatafile
}

/**
 * Server-side helper: produce a pre-evaluated bootstrap blob for one
 * context, ready to embed in an SSR response. Browser SDK hydrates with
 * `ready: true` on first render, so there's no flicker.
 */
export async function getServerBootstrap(
  client: SnapshotClient,
  ctx: EvalContext,
  opts?: { includeDatafile?: boolean }
): Promise<BootstrapBlob> {
  return serializeBootstrap(client, ctx, opts)
}

function summarise(ctx: EvalContext): Array<{ kind: string; key: string }> {
  if (isMultiContext(ctx)) {
    const out: Array<{ kind: string; key: string }> = []
    for (const [k, v] of Object.entries(ctx)) {
      if (k === 'kind') continue
      if (!v || typeof v !== 'object') continue
      const sub = v as SingleContext
      out.push({ kind: sub.kind, key: sub.key })
    }
    return out
  }
  return [{ kind: ctx.kind, key: ctx.key }]
}
