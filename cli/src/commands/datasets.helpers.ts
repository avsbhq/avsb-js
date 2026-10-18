/**
 * Helpers shared by the `avsb datasets` subcommands. Kept separate from
 * `datasets.ts` so the command file stays focused on commander wiring and
 * the logic here is unit-testable with a faked API client.
 *
 * Spec: _specs/ecommerce-suite-spec.md §2.3 (CLI bullet) + §2.5 (routes)
 */

import fs from 'node:fs'
import path from 'node:path'
import type {
  CliDataset,
  CliDatasetVersion,
  CliDatasetVersionError,
  ApiDatasetListResponse,
  ApiDatasetDetailResponse,
  ApiDatasetVersionCreateResponse,
  ApiDatasetVersionResponse,
  ApiDatasetActivateResponse,
} from '../types/dataset.js'

/**
 * Structural slice of `ApiClient` the dataset flows need — lets tests
 * inject a fake without standing up HTTP. All methods address the project
 * by its numeric short id (PRJ-42 → 42), matching the personal-token
 * `/api/cli/projects/{shortId}/datasets/...` routes.
 */
export interface DatasetsApi {
  listDatasets(projectShortId: number): Promise<ApiDatasetListResponse>
  getDataset(
    projectShortId: number,
    datasetId: string,
  ): Promise<ApiDatasetDetailResponse>
  createDatasetVersion(
    projectShortId: number,
    datasetId: string,
    body?: { label?: string },
  ): Promise<ApiDatasetVersionCreateResponse>
  commitDatasetVersion(
    projectShortId: number,
    datasetId: string,
    versionId: string,
  ): Promise<ApiDatasetVersionResponse>
  activateDatasetVersion(
    projectShortId: number,
    datasetId: string,
    versionId: string,
  ): Promise<ApiDatasetActivateResponse>
  uploadNdjson(uploadUrl: string, body: Buffer | string): Promise<void>
}

// ── Argument parsing ────────────────────────────────────────

/**
 * Parse a version argument: accepts `12`, `v12` or `V12` and returns the
 * numeric version short id. Throws on anything else.
 */
export function parseVersionArg(raw: string): number {
  const normalized = raw.trim().replace(/^[vV]/, '')
  if (!/^\d+$/.test(normalized)) {
    throw new Error(
      `Invalid version "${raw}". Use the numeric version short id, e.g. 12 or v12.`,
    )
  }
  const shortId = Number(normalized)
  if (shortId <= 0) {
    throw new Error(`Invalid version "${raw}". Version short ids start at 1.`)
  }
  return shortId
}

/**
 * Validate the NDJSON file argument: must exist, be a regular file and use
 * the .ndjson extension (CSV conversion is a dashboard convenience — the
 * CLI is NDJSON only). Returns the resolved absolute path.
 */
export function validateNdjsonPath(filePath: string): string {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`File not found: ${resolved}`)
  }
  if (path.extname(resolved).toLowerCase() !== '.ndjson') {
    throw new Error(
      `Expected an .ndjson file, got "${path.basename(resolved)}". ` +
        'Convert CSV files in the dashboard upload modal, or export NDJSON directly.',
    )
  }
  return resolved
}

// ── Lookups ─────────────────────────────────────────────────

export async function resolveDatasetBySlug(
  api: DatasetsApi,
  projectShortId: number,
  slug: string,
): Promise<CliDataset> {
  const response = await api.listDatasets(projectShortId)
  const dataset = response.data.datasets.find((d) => d.slug === slug)
  if (!dataset) {
    const known = response.data.datasets.map((d) => d.slug)
    throw new Error(
      known.length > 0
        ? `No dataset with slug "${slug}". Known slugs: ${known.join(', ')}`
        : `No dataset with slug "${slug}". This project has no datasets yet. Create one in the dashboard first.`,
    )
  }
  return dataset
}

export function findVersionByShortId(
  versions: CliDatasetVersion[],
  shortId: number,
): CliDatasetVersion | undefined {
  return versions.find((v) => v.shortId === shortId)
}

/**
 * Pick the rollback target: the most recent COMMITTED non-live version older
 * than the current live one. ARCHIVED versions are excluded — the server only
 * activates COMMITTED versions, and the GC cron deletes ARCHIVED KV keys, so
 * they can never be re-activated. Version short ids are monotonically
 * increasing, so "older" compares short ids.
 */
export function findRollbackTarget(
  versions: CliDatasetVersion[],
  liveVersionId: string | null,
): RollbackResolution {
  const live = liveVersionId
    ? versions.find((v) => v.id === liveVersionId)
    : undefined
  if (!live) return { ok: false, reason: 'no-live' }

  const older = versions.filter((v) => v.id !== live.id && v.shortId < live.shortId)
  const candidates = older
    .filter((v) => v.status === 'COMMITTED')
    .sort((a, b) => b.shortId - a.shortId)

  if (candidates.length === 0) {
    // Distinguish "retention archived everything" so the CLI can explain why.
    const archivedOnly = older.some((v) => v.status === 'ARCHIVED')
    return { ok: false, reason: archivedOnly ? 'archived-only' : 'no-candidate', live }
  }
  return { ok: true, target: candidates[0], live }
}

export type RollbackResolution =
  | { ok: true; target: CliDatasetVersion; live: CliDatasetVersion }
  | { ok: false; reason: 'no-live' }
  | { ok: false; reason: 'no-candidate' | 'archived-only'; live: CliDatasetVersion }

// ── Polling ─────────────────────────────────────────────────

const SETTLED_STATUSES = new Set(['COMMITTED', 'ACTIVE', 'FAILED'])

export interface PollOptions {
  intervalMs?: number
  timeoutMs?: number
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll the dataset detail (which carries the version list) until the given
 * version reaches a settled status (COMMITTED, ACTIVE or FAILED) or the
 * timeout elapses.
 */
export async function pollVersionUntilSettled(
  api: DatasetsApi,
  projectShortId: number,
  datasetId: string,
  versionId: string,
  options: PollOptions = {},
): Promise<CliDatasetVersion> {
  const intervalMs = options.intervalMs ?? 2_000
  const timeoutMs = options.timeoutMs ?? 300_000
  const sleep = options.sleep ?? defaultSleep
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const response = await api.getDataset(projectShortId, datasetId)
    const version = response.data.versions.find((v) => v.id === versionId)
    if (!version) {
      throw new Error(`Version ${versionId} disappeared while waiting for commit.`)
    }
    if (SETTLED_STATUSES.has(version.status)) return version
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the commit to finish ` +
          `(last status: ${version.status}). The ingest may still complete, so check \`avsb datasets list\`.`,
      )
    }
    await sleep(intervalMs)
  }
}

// ── Push flow ───────────────────────────────────────────────

export interface PushFlowOptions {
  slug: string
  fileBody: Buffer | string
  label?: string
  activate?: boolean
  poll?: PollOptions
  /** Progress hook for spinner updates. */
  onStep?: (step: string) => void
}

export interface PushFlowResult {
  dataset: CliDataset
  version: CliDatasetVersion
  activated: boolean
}

/**
 * `avsb datasets push` orchestration: create version → PUT NDJSON to the
 * presigned upload URL → commit → poll until COMMITTED/FAILED → optionally
 * activate. Throws with a descriptive message on any failure.
 */
export async function runPushFlow(
  api: DatasetsApi,
  projectShortId: number,
  options: PushFlowOptions,
): Promise<PushFlowResult> {
  const { slug, fileBody, label, activate, poll, onStep } = options

  onStep?.('Resolving dataset')
  const dataset = await resolveDatasetBySlug(api, projectShortId, slug)

  onStep?.('Creating version')
  const created = await api.createDatasetVersion(
    projectShortId,
    dataset.id,
    label ? { label } : {},
  )
  const { version, uploadUrl } = created.data

  onStep?.('Uploading NDJSON')
  await api.uploadNdjson(uploadUrl, fileBody)

  onStep?.('Committing')
  await api.commitDatasetVersion(projectShortId, dataset.id, version.id)

  onStep?.('Waiting for commit to finish')
  const settled = await pollVersionUntilSettled(api, projectShortId, dataset.id, version.id, poll)

  if (settled.status === 'FAILED') {
    throw new Error(`Commit failed: ${describeVersionError(settled.error)}`)
  }

  let activated = false
  if (activate) {
    onStep?.('Activating')
    await api.activateDatasetVersion(projectShortId, dataset.id, settled.id)
    activated = true
  }

  return { dataset, version: settled, activated }
}

// ── Formatting ──────────────────────────────────────────────

export function describeVersionError(error: CliDatasetVersionError | null): string {
  if (!error) return 'unknown error'
  if (error.line != null && error.reason) return `line ${error.line}: ${error.reason}`
  if (error.reason) return error.reason
  if (error.line != null) return `error at line ${error.line}`
  return 'unknown error'
}

export function versionLabel(version: { shortId: number }): string {
  return `v${version.shortId}`
}

export function liveVersionLabel(dataset: CliDataset): string {
  if (dataset.liveVersionShortId != null) return `v${dataset.liveVersionShortId}`
  // Defensive: a server that sets the pointer without the flattened shortId.
  if (dataset.liveVersionId) return 'live'
  return '—'
}

export function formatTimestamp(iso: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

/** Build aligned table lines for `avsb datasets list`. */
export function formatDatasetTable(datasets: CliDataset[]): string[] {
  const rows = datasets.map((d) => ({
    slug: d.slug,
    type: d.type,
    live: liveVersionLabel(d),
    updated: formatTimestamp(d.updatedAt),
  }))
  const widths = {
    slug: Math.max(4, ...rows.map((r) => r.slug.length)),
    type: Math.max(4, ...rows.map((r) => r.type.length)),
    live: Math.max(4, ...rows.map((r) => r.live.length)),
  }
  const header = [
    'Slug'.padEnd(widths.slug),
    'Type'.padEnd(widths.type),
    'Live'.padEnd(widths.live),
    'Updated',
  ].join('  ')
  const lines = rows.map((r) =>
    [
      r.slug.padEnd(widths.slug),
      r.type.padEnd(widths.type),
      r.live.padEnd(widths.live),
      r.updated,
    ].join('  '),
  )
  return [header, ...lines]
}
