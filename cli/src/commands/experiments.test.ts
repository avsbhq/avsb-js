import { describe, expect, it } from 'vitest'
import { formatExperimentTable } from './experiments.js'
import type { CliPublicExperiment } from '../types/experiment.js'

function experiment(overrides: Partial<CliPublicExperiment> = {}): CliPublicExperiment {
  return {
    id: 'exp_1',
    shortId: 7,
    name: 'Homepage hero copy',
    status: 'RUNNING',
    createdAt: '2026-01-02T10:00:00.000Z',
    updatedAt: '2026-02-03T11:22:33.000Z',
    ...overrides,
  }
}

describe('formatExperimentTable', () => {
  it('prints the id in the EXP- form the rest of the CLI uses', () => {
    const [, row] = formatExperimentTable([experiment()])

    expect(row).toContain('EXP-7')
  })

  it('shows the date only, not a full timestamp nobody can scan', () => {
    const [, row] = formatExperimentTable([experiment()])

    expect(row).toContain('2026-02-03')
    expect(row).not.toContain('11:22:33')
  })

  it('lines the columns up across rows of different widths', () => {
    const [, first, second] = formatExperimentTable([
      experiment(),
      experiment({ shortId: 1234, status: 'DRAFT', name: 'A' }),
    ])

    expect(first.indexOf('RUNNING')).toBe(second.indexOf('DRAFT'))
  })

  it('truncates a long name instead of breaking the columns', () => {
    const [, row] = formatExperimentTable([experiment({ name: 'x'.repeat(80) })])

    expect(row).toContain('…')
    expect(row.length).toBeLessThan(80 + 30)
  })

  it('returns just the header for an empty list', () => {
    expect(formatExperimentTable([])).toHaveLength(1)
  })
})
