import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `--percentile` on the update path (§5.24).
 *
 * The create path has always refused a percentile outside 0 < p < 100. The
 * update path only checked that the number was finite, so `--percentile 0` was
 * sent to the server, refused there, and came back as an API error rather than
 * a usage error naming the flag. The server enforces the bound either way, so
 * this is a bad error message, not a data hole, and the fix is to make the two
 * paths say the same thing.
 */

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    dim: vi.fn(),
    heading: vi.fn(),
    label: vi.fn(),
    field: vi.fn(),
    fileTree: vi.fn(),
    errorDetail: vi.fn(),
    line: vi.fn(),
  },
}))

vi.mock('../lib/logger.js', () => mocks.logger)

import { buildCreateMetricBindingBody, buildUpdateMetricBindingPatch } from './metric-bindings.body.js'
import { formatMetricBindingTable, readMetricBinding, readMetricBindingList } from './metric-bindings.helpers.js'
import type { CliMetricBinding } from '../types/metricBinding.js'

/** `failCommand` ends in `process.exit`, so the spy turns it into a throw. */
class ProcessExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

const OUT_OF_RANGE = '--percentile must be a number strictly between 0 and 100.'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ProcessExitError(typeof code === 'number' ? code : 0)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildUpdateMetricBindingPatch --percentile', () => {
  it('refuses 0, which is not a percentile any metric can report', () => {
    expect(() => buildUpdateMetricBindingPatch({ percentile: '0' })).toThrow(ProcessExitError)
    expect(mocks.logger.error).toHaveBeenCalledWith(OUT_OF_RANGE)
  })

  it('refuses 100, the other end of the same open interval', () => {
    expect(() => buildUpdateMetricBindingPatch({ percentile: '100' })).toThrow(ProcessExitError)
    expect(mocks.logger.error).toHaveBeenCalledWith(OUT_OF_RANGE)
  })

  it('refuses a negative percentile', () => {
    expect(() => buildUpdateMetricBindingPatch({ percentile: '-5' })).toThrow(ProcessExitError)
  })

  it('refuses a value that is not a number at all', () => {
    expect(() => buildUpdateMetricBindingPatch({ percentile: 'p95' })).toThrow(ProcessExitError)
  })

  it('accepts 95, the percentile people actually ask for', () => {
    expect(buildUpdateMetricBindingPatch({ percentile: '95' })).toEqual({ percentile: 95 })
  })

  it('accepts a fractional percentile inside the interval', () => {
    expect(buildUpdateMetricBindingPatch({ percentile: '99.9' })).toEqual({ percentile: 99.9 })
  })

  it('leaves the patch empty when --percentile is not passed', () => {
    // An omitted flag must not become a written value.
    expect(buildUpdateMetricBindingPatch({})).toEqual({})
  })

  it('refuses the same values the create path refuses, with the same message', () => {
    // The whole point of the change: one bound, one sentence, both paths.
    for (const bad of ['0', '100']) {
      mocks.logger.error.mockClear()
      expect(() =>
        buildCreateMetricBindingBody(
          'PERCENTILE',
          { metric: 'metric-1', percentile: bad },
          'p-metric',
        ),
      ).toThrow(ProcessExitError)
      const createMessage = mocks.logger.error.mock.calls[0]?.[0]

      mocks.logger.error.mockClear()
      expect(() => buildUpdateMetricBindingPatch({ percentile: bad })).toThrow(ProcessExitError)
      expect(mocks.logger.error.mock.calls[0]?.[0]).toBe(createMessage)
    }
  })
})

describe('the create body and the answers the platform sends (N4-4)', () => {
  it('sends no projectId and passes the metric id the user typed through untouched', () => {
    const body = buildCreateMetricBindingBody('UNIQUE_CONVERSIONS_PER_VISITOR', { metric: 'MET-52' }, 'Add to cart rate')

    expect(body).not.toHaveProperty('projectId')
    expect(body.metricId).toBe('MET-52')
    expect(body).toMatchObject({ measure: 'UNIQUE_CONVERSIONS_PER_VISITOR', direction: 'INCREASE', isLibrary: true })
  })

  it('reads the created binding from { metricBinding }', () => {
    expect(readMetricBinding({ metricBinding: binding() })?.shortId).toBe(400051)
  })

  it('treats the old { metric } answer as unreadable, so a create that worked is never reported as failed', () => {
    // This is the answer that printed "Failed to create metric binding" while
    // the binding existed, so a retrying script made duplicates.
    expect(readMetricBinding({ metric: binding() })).toBeNull()
  })

  it('reads the list from { metricBindings } and refuses the old { metrics } shape', () => {
    expect(readMetricBindingList({ metricBindings: [binding()] })?.map((b) => b.id)).toEqual(['cm-binding-1'])
    expect(readMetricBindingList({ metrics: [binding()] })).toBeNull()
  })

  it('formats the list with the MBD- id and the measure', () => {
    const table = formatMetricBindingTable([binding()])

    expect(table.heading.split(/\s{2,}/)).toEqual(['ID', 'Measure', 'Name', 'Sentence'])
    expect(table.rows[0]).toMatch(/^MBD-400051\s+\S/)
    expect(table.rows[0]).toContain('Purchases rate')
  })
})

function binding(): CliMetricBinding {
  return {
    id: 'cm-binding-1',
    shortId: 400051,
    orgId: 'org-1',
    projectId: 'proj_1',
    name: 'Purchases rate',
    description: null,
    measure: 'UNIQUE_CONVERSIONS_PER_VISITOR',
    direction: 'INCREASE',
    isLibrary: true,
    metricId: 'cm-metric-1',
    numeratorMetricId: null,
    denominatorMetricId: null,
    percentile: null,
    valueSource: null,
    winsorization: null,
    composition: null,
    archivedAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    createdByUserId: null,
    metric: null,
    numeratorMetric: null,
    denominatorMetric: null,
  }
}
