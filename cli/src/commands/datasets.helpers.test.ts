import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseVersionArg,
  validateNdjsonPath,
  resolveDatasetBySlug,
  findVersionByShortId,
  findRollbackTarget,
  pollVersionUntilSettled,
  runPushFlow,
  describeVersionError,
  liveVersionLabel,
  formatTimestamp,
  formatDatasetTable,
  type DatasetsApi,
} from './datasets.helpers.js'
import type { CliDataset, CliDatasetVersion } from '../types/dataset.js'

// Numeric project short id (PRJ-42) — the personal-token CLI routes
// address projects by short id, not org/project cuids.
const projectShortId = 42

function makeDataset(overrides: Partial<CliDataset> = {}): CliDataset {
  return {
    id: 'ds_1',
    shortId: 1,
    projectId: 'proj_1',
    slug: 'vip-customers',
    name: 'VIP customers',
    type: 'LIST',
    source: 'USER',
    keyField: 'key',
    liveVersionId: null,
    liveVersionShortId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-10T12:30:00.000Z',
    ...overrides,
  }
}

function makeVersion(overrides: Partial<CliDatasetVersion> = {}): CliDatasetVersion {
  return {
    id: 'dsv_1',
    shortId: 1,
    datasetId: 'ds_1',
    label: null,
    status: 'COMMITTED',
    rowCount: 100,
    error: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    committedAt: '2026-06-01T00:01:00.000Z',
    ...overrides,
  }
}

function makeApi(overrides: Partial<DatasetsApi> = {}): DatasetsApi {
  return {
    listDatasets: vi.fn().mockResolvedValue({ data: { datasets: [makeDataset()] } }),
    getDataset: vi.fn().mockResolvedValue({
      data: { dataset: makeDataset(), versions: [makeVersion()] },
    }),
    createDatasetVersion: vi.fn().mockResolvedValue({
      data: { version: makeVersion({ status: 'UPLOADING' }), uploadUrl: 'https://r2.example.com/put' },
    }),
    commitDatasetVersion: vi.fn().mockResolvedValue({
      data: { version: makeVersion({ status: 'COMMITTING' }) },
    }),
    activateDatasetVersion: vi.fn().mockResolvedValue({
      data: {
        dataset: makeDataset({ liveVersionId: 'dsv_1' }),
        version: makeVersion({ status: 'ACTIVE' }),
      },
    }),
    uploadNdjson: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

const immediateSleep = (): Promise<void> => Promise.resolve()

// ── parseVersionArg ─────────────────────────────────────────

describe('parseVersionArg', () => {
  it('parses a plain numeric version', () => {
    expect(parseVersionArg('12')).toBe(12)
  })

  it('parses v-prefixed versions case-insensitively', () => {
    expect(parseVersionArg('v7')).toBe(7)
    expect(parseVersionArg('V7')).toBe(7)
  })

  it('throws on non-numeric input', () => {
    expect(() => parseVersionArg('latest')).toThrow(/Invalid version "latest"/)
  })

  it('throws on zero (short ids start at 1)', () => {
    expect(() => parseVersionArg('0')).toThrow(/start at 1/)
  })

  it('throws on negative or decimal input', () => {
    expect(() => parseVersionArg('-3')).toThrow(/Invalid version/)
    expect(() => parseVersionArg('1.5')).toThrow(/Invalid version/)
  })
})

// ── validateNdjsonPath ──────────────────────────────────────

describe('validateNdjsonPath', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avsb-datasets-test-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns the resolved path for an existing .ndjson file', () => {
    const file = path.join(dir, 'rows.ndjson')
    fs.writeFileSync(file, '{"key":"a"}\n')
    expect(validateNdjsonPath(file)).toBe(file)
  })

  it('throws when the file does not exist', () => {
    expect(() => validateNdjsonPath(path.join(dir, 'missing.ndjson'))).toThrow(/File not found/)
  })

  it('rejects non-.ndjson extensions and points at the dashboard CSV path', () => {
    const file = path.join(dir, 'rows.csv')
    fs.writeFileSync(file, 'key\na\n')
    expect(() => validateNdjsonPath(file)).toThrow(/Expected an \.ndjson file.*dashboard/)
  })
})

// ── resolveDatasetBySlug ────────────────────────────────────

describe('resolveDatasetBySlug', () => {
  it('returns the dataset matching the slug', async () => {
    const api = makeApi()
    const dataset = await resolveDatasetBySlug(api, projectShortId, 'vip-customers')
    expect(dataset.id).toBe('ds_1')
    expect(api.listDatasets).toHaveBeenCalledWith(42)
  })

  it('throws with known slugs listed when the slug does not match', async () => {
    const api = makeApi()
    await expect(resolveDatasetBySlug(api, projectShortId, 'nope')).rejects.toThrow(
      /No dataset with slug "nope".*vip-customers/,
    )
  })

  it('throws a create-first hint when the project has no datasets', async () => {
    const api = makeApi({
      listDatasets: vi.fn().mockResolvedValue({ data: { datasets: [] } }),
    })
    await expect(resolveDatasetBySlug(api, projectShortId, 'nope')).rejects.toThrow(/no datasets yet/)
  })
})

// ── findVersionByShortId / findRollbackTarget ───────────────

describe('findVersionByShortId', () => {
  it('finds a version by numeric short id', () => {
    const versions = [makeVersion({ id: 'a', shortId: 1 }), makeVersion({ id: 'b', shortId: 2 })]
    expect(findVersionByShortId(versions, 2)?.id).toBe('b')
  })

  it('returns undefined when absent', () => {
    expect(findVersionByShortId([makeVersion({ shortId: 1 })], 9)).toBeUndefined()
  })
})

describe('findRollbackTarget', () => {
  const live = makeVersion({ id: 'live', shortId: 5, status: 'ACTIVE' })

  it('picks the most recent committed version older than the live one', () => {
    const versions = [
      makeVersion({ id: 'v2', shortId: 2, status: 'COMMITTED' }),
      makeVersion({ id: 'v4', shortId: 4, status: 'COMMITTED' }),
      live,
    ]
    const result = findRollbackTarget(versions, 'live')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.target.id).toBe('v4')
      expect(result.live.id).toBe('live')
    }
  })

  it('skips ARCHIVED versions (the server cannot re-activate them) and picks the older COMMITTED one', () => {
    const versions = [
      makeVersion({ id: 'v4', shortId: 4, status: 'ARCHIVED' }),
      makeVersion({ id: 'v2', shortId: 2, status: 'COMMITTED' }),
      live,
    ]
    const result = findRollbackTarget(versions, 'live')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.target.id).toBe('v2')
  })

  it('reports archived-only when every older candidate has been archived by retention', () => {
    const versions = [
      makeVersion({ id: 'v3', shortId: 3, status: 'ARCHIVED' }),
      makeVersion({ id: 'v4', shortId: 4, status: 'ARCHIVED' }),
      live,
    ]
    expect(findRollbackTarget(versions, 'live')).toEqual({
      ok: false,
      reason: 'archived-only',
      live,
    })
  })

  it('skips FAILED and newer versions', () => {
    const versions = [
      makeVersion({ id: 'bad', shortId: 4, status: 'FAILED' }),
      makeVersion({ id: 'newer', shortId: 6, status: 'COMMITTED' }),
      live,
    ]
    const result = findRollbackTarget(versions, 'live')
    expect(result).toEqual({ ok: false, reason: 'no-candidate', live })
  })

  it('reports no-live when the dataset has no live version', () => {
    expect(findRollbackTarget([makeVersion()], null)).toEqual({ ok: false, reason: 'no-live' })
  })

  it('reports no-live when liveVersionId points at a missing version', () => {
    expect(findRollbackTarget([makeVersion({ id: 'x' })], 'gone')).toEqual({
      ok: false,
      reason: 'no-live',
    })
  })
})

// ── pollVersionUntilSettled ─────────────────────────────────

describe('pollVersionUntilSettled', () => {
  const detail = (versions: CliDatasetVersion[]) => ({
    data: { dataset: makeDataset(), versions },
  })

  it('returns as soon as the version reports COMMITTED', async () => {
    const getDataset = vi
      .fn()
      .mockResolvedValueOnce(detail([makeVersion({ status: 'COMMITTING' })]))
      .mockResolvedValueOnce(detail([makeVersion({ status: 'COMMITTED', rowCount: 250 })]))
    const api = makeApi({ getDataset })

    const settled = await pollVersionUntilSettled(api, projectShortId, 'ds_1', 'dsv_1', {
      sleep: immediateSleep,
    })

    expect(settled.status).toBe('COMMITTED')
    expect(settled.rowCount).toBe(250)
    expect(getDataset).toHaveBeenCalledTimes(2)
    expect(getDataset).toHaveBeenCalledWith(42, 'ds_1')
  })

  it('returns a FAILED version (caller decides how to surface the error)', async () => {
    const failed = makeVersion({ status: 'FAILED', error: { line: 42, reason: 'missing key field' } })
    const api = makeApi({
      getDataset: vi.fn().mockResolvedValue(detail([failed])),
    })

    const settled = await pollVersionUntilSettled(api, projectShortId, 'ds_1', 'dsv_1', { sleep: immediateSleep })
    expect(settled.status).toBe('FAILED')
    expect(settled.error).toEqual({ line: 42, reason: 'missing key field' })
  })

  it('throws a descriptive timeout error when the version never settles', async () => {
    const api = makeApi({
      getDataset: vi.fn().mockResolvedValue(detail([makeVersion({ status: 'COMMITTING' })])),
    })

    await expect(
      pollVersionUntilSettled(api, projectShortId, 'ds_1', 'dsv_1', {
        sleep: immediateSleep,
        timeoutMs: 0,
      }),
    ).rejects.toThrow(/Timed out.*COMMITTING/)
  })

  it('throws when the version disappears from the list', async () => {
    const api = makeApi({
      getDataset: vi.fn().mockResolvedValue(detail([])),
    })

    await expect(
      pollVersionUntilSettled(api, projectShortId, 'ds_1', 'dsv_1', { sleep: immediateSleep }),
    ).rejects.toThrow(/disappeared/)
  })
})

// ── runPushFlow ─────────────────────────────────────────────

describe('runPushFlow', () => {
  it('runs create → upload → commit → poll and reports the committed version', async () => {
    const committed = makeVersion({ status: 'COMMITTED', rowCount: 3 })
    const api = makeApi({
      getDataset: vi.fn().mockResolvedValue({
        data: { dataset: makeDataset(), versions: [committed] },
      }),
    })
    const steps: string[] = []

    const result = await runPushFlow(api, projectShortId, {
      slug: 'vip-customers',
      fileBody: '{"key":"a"}\n',
      label: 'nightly',
      poll: { sleep: immediateSleep },
      onStep: (s) => steps.push(s),
    })

    expect(result.version.status).toBe('COMMITTED')
    expect(result.version.rowCount).toBe(3)
    expect(result.activated).toBe(false)
    expect(api.createDatasetVersion).toHaveBeenCalledWith(42, 'ds_1', {
      label: 'nightly',
    })
    expect(api.uploadNdjson).toHaveBeenCalledWith('https://r2.example.com/put', '{"key":"a"}\n')
    expect(api.commitDatasetVersion).toHaveBeenCalledWith(42, 'ds_1', 'dsv_1')
    expect(api.activateDatasetVersion).not.toHaveBeenCalled()
    expect(steps).toEqual([
      'Resolving dataset',
      'Creating version',
      'Uploading NDJSON',
      'Committing',
      'Waiting for commit to finish',
    ])
  })

  it('activates after commit when activate is set', async () => {
    const api = makeApi()

    const result = await runPushFlow(api, projectShortId, {
      slug: 'vip-customers',
      fileBody: '{"key":"a"}\n',
      activate: true,
      poll: { sleep: immediateSleep },
    })

    expect(result.activated).toBe(true)
    expect(api.activateDatasetVersion).toHaveBeenCalledWith(42, 'ds_1', 'dsv_1')
  })

  it('throws with the {line, reason} detail when the commit fails', async () => {
    const failed = makeVersion({ status: 'FAILED', error: { line: 7, reason: 'row exceeds 64KB' } })
    const api = makeApi({
      getDataset: vi.fn().mockResolvedValue({
        data: { dataset: makeDataset(), versions: [failed] },
      }),
    })

    await expect(
      runPushFlow(api, projectShortId, {
        slug: 'vip-customers',
        fileBody: '{"key":"a"}\n',
        poll: { sleep: immediateSleep },
      }),
    ).rejects.toThrow('Commit failed: line 7: row exceeds 64KB')
  })

  it('surfaces upload failures without committing', async () => {
    const api = makeApi({
      uploadNdjson: vi.fn().mockRejectedValue(new Error('Upload failed: HTTP 403')),
    })

    await expect(
      runPushFlow(api, projectShortId, { slug: 'vip-customers', fileBody: 'x' }),
    ).rejects.toThrow('Upload failed: HTTP 403')
    expect(api.commitDatasetVersion).not.toHaveBeenCalled()
  })

  it('surfaces unknown-slug failures before creating anything', async () => {
    const api = makeApi()

    await expect(
      runPushFlow(api, projectShortId, { slug: 'nope', fileBody: 'x' }),
    ).rejects.toThrow(/No dataset with slug "nope"/)
    expect(api.createDatasetVersion).not.toHaveBeenCalled()
  })
})

// ── Formatting ──────────────────────────────────────────────

describe('describeVersionError', () => {
  it('formats line + reason', () => {
    expect(describeVersionError({ line: 42, reason: 'missing key' })).toBe('line 42: missing key')
  })

  it('formats reason-only and line-only errors', () => {
    expect(describeVersionError({ reason: 'too many rows' })).toBe('too many rows')
    expect(describeVersionError({ line: 9 })).toBe('error at line 9')
  })

  it('falls back to "unknown error" for null or empty errors', () => {
    expect(describeVersionError(null)).toBe('unknown error')
    expect(describeVersionError({})).toBe('unknown error')
  })
})

describe('liveVersionLabel', () => {
  it('renders the flattened liveVersionShortId the wire ships', () => {
    const dataset = makeDataset({ liveVersionId: 'x', liveVersionShortId: 4 })
    expect(liveVersionLabel(dataset)).toBe('v4')
  })

  it('falls back to "live" when only liveVersionId is present', () => {
    expect(liveVersionLabel(makeDataset({ liveVersionId: 'x' }))).toBe('live')
  })

  it('shows a dash when there is no live version', () => {
    expect(liveVersionLabel(makeDataset())).toBe('—')
  })
})

describe('formatTimestamp', () => {
  it('formats ISO timestamps as "YYYY-MM-DD HH:mm"', () => {
    expect(formatTimestamp('2026-06-10T12:30:45.000Z')).toBe('2026-06-10 12:30')
  })

  it('returns a dash for empty or invalid input', () => {
    expect(formatTimestamp('')).toBe('—')
    expect(formatTimestamp('not-a-date')).toBe('—')
  })
})

describe('formatDatasetTable', () => {
  it('produces a header plus one aligned row per dataset', () => {
    const lines = formatDatasetTable([
      makeDataset({ slug: 'vip', type: 'LIST', liveVersionId: 'x', liveVersionShortId: 2 }),
      makeDataset({ slug: 'product-catalog', type: 'TABLE' }),
    ])
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^Slug\s+Type\s+Live\s+Updated$/)
    expect(lines[1]).toContain('vip')
    expect(lines[1]).toContain('v2')
    expect(lines[2]).toContain('product-catalog')
    expect(lines[2]).toContain('—')
  })
})
