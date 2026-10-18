import { describe, expect, it } from 'vitest'
import { buildStatusRows } from './status.js'
import type { AvsbManifest } from '../types/experiment.js'

function makeManifest(overrides: Partial<AvsbManifest> = {}): AvsbManifest {
  return {
    version: 1,
    experimentId: 'exp_1',
    experimentShortId: 300015,
    experimentName: 'Homepage hero test',
    projectId: 'proj_1',
    projectShortId: 42,
    orgId: 'org-1',
    snippetKey: 'snip_abc',
    status: 'RUNNING',
    languages: { script: 'ts', style: 'scss' },
    trafficAlloc: 100,
    targetingRules: [],
    variations: [
      {
        id: 'var_1',
        shortId: 1,
        name: 'Control',
        type: 'CONTROL',
        weight: 50,
        folder: 'control',
        scriptFile: 'control.ts',
        styleFile: 'control.scss',
      },
      {
        id: 'var_2',
        shortId: 2,
        name: 'Variant A',
        type: 'VARIANT',
        weight: 50,
        folder: 'variant-a',
        scriptFile: 'variant-a.ts',
        styleFile: 'variant-a.scss',
      },
    ],
    allowedVariations: [1, 2],
    lastSyncedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    platformUrl: 'https://app.avsb.cloud/projects/42/experiments/300015',
    ...overrides,
  }
}

describe('buildStatusRows', () => {
  it('reports exactly the manifest facts it has, in a fixed order', () => {
    const labels = buildStatusRows(makeManifest()).map((row) => row.label)

    expect(labels).toEqual([
      'Experiment',
      'Status',
      'Variations',
      'Script',
      'Style',
      'Last synced',
      'Platform',
    ])
  })

  // The docs used to claim `avsb status` shows whether local files are ahead of
  // or behind the platform. Nothing here compares against the platform, so no
  // row may imply that it does.
  it('claims nothing about being ahead of or behind the platform', () => {
    const printed = buildStatusRows(makeManifest())
      .map((row) => `${row.label} ${row.value}`)
      .join('\n')
      .toLowerCase()

    expect(printed).not.toContain('ahead')
    expect(printed).not.toContain('behind')
    expect(printed).not.toContain('in sync')
    expect(printed).not.toContain('pending')
  })

  it('prints the experiment short id in EXP form and counts the variations', () => {
    const rows = buildStatusRows(makeManifest())

    expect(rows.find((row) => row.label === 'Experiment')?.value).toBe('EXP-300015')
    expect(rows.find((row) => row.label === 'Variations')?.value).toBe('2')
  })

  it('upper-cases the language pair from the manifest', () => {
    const rows = buildStatusRows(
      makeManifest({ languages: { script: 'js', style: 'css' } }),
    )

    expect(rows.find((row) => row.label === 'Script')?.value).toBe('JS')
    expect(rows.find((row) => row.label === 'Style')?.value).toBe('CSS')
  })

  it('keeps the raw status word (colour codes aside)', () => {
    const rows = buildStatusRows(makeManifest({ status: 'DRAFT' }))

    expect(rows.find((row) => row.label === 'Status')?.value).toContain('DRAFT')
  })

  it('formats the sync time as a relative phrase', () => {
    const justNow = buildStatusRows(
      makeManifest({ lastSyncedAt: new Date().toISOString() }),
    )
    expect(justNow.find((row) => row.label === 'Last synced')?.value).toBe('just now')

    const hoursAgo = buildStatusRows(
      makeManifest({
        lastSyncedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      }),
    )
    expect(hoursAgo.find((row) => row.label === 'Last synced')?.value).toBe('3 hours ago')

    const daysAgo = buildStatusRows(
      makeManifest({
        lastSyncedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      }),
    )
    expect(daysAgo.find((row) => row.label === 'Last synced')?.value).toBe('2 days ago')
  })
})
