import { describe, expect, it } from 'vitest'
import {
  buildCreateBody,
  describeArchiveCascade,
  formatMetricTable,
  readMetric,
  readMetricList,
} from './metrics.helpers.js'
import type { CliMetric } from '../types/metric.js'

function metric(overrides: Partial<CliMetric> = {}): CliMetric {
  return {
    id: 'cm-metric-1',
    shortId: 52,
    projectId: 'proj_1',
    name: 'Add to cart',
    description: null,
    type: 'CLICK',
    cssSelector: '.btn-add-to-cart',
    urlMatch: null,
    urlMatchMode: null,
    pageUrl: null,
    eventKey: null,
    hasValueField: false,
    archivedAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  }
}

describe('the answers the platform sends (N4-3)', () => {
  it('reads the list answer { metrics, usage }', () => {
    const list = readMetricList({
      metrics: [metric()],
      usage: { 'cm-metric-1': { experimentCount: 3, flagRuleCount: 1 } },
    })

    expect(list?.metrics.map((m) => m.shortId)).toEqual([52])
    expect(list?.usage['cm-metric-1']).toEqual({ experimentCount: 3, flagRuleCount: 1 })
  })

  it('reads a list with no usage map as zero usage rather than crashing', () => {
    expect(readMetricList({ metrics: [metric()] })?.usage).toEqual({})
  })

  it('refuses the old { events } list shape instead of reading .length of undefined', () => {
    expect(readMetricList({ events: [metric()] })).toBeNull()
  })

  it('reads the created metric from { metric }, and reports an unknown shape as null, never as a thrown failure', () => {
    expect(readMetric({ metric: metric() })?.name).toBe('Add to cart')
    // The old answer: the create had worked, so the command warns and exits 0
    // instead of printing "Failed to create metric".
    expect(readMetric({ event: metric() })).toBeNull()
    expect(readMetric(undefined)).toBeNull()
  })
})

describe('formatMetricTable', () => {
  it('prints the MET- id, the definition and usage as <experiments>m/<flag rules>r', () => {
    const table = formatMetricTable([metric(), metric({ id: 'cm-2', shortId: 7, name: 'Checkout', type: 'PAGEVIEW', cssSelector: null, urlMatch: '/checkout', urlMatchMode: 'PATH', archivedAt: '2026-10-02T00:00:00.000Z' })], {
      'cm-metric-1': { experimentCount: 3, flagRuleCount: 1 },
    })

    expect(table.heading.split(/\s{2,}/)).toEqual(['ID', 'Type', 'Name', 'Definition', 'Usage'])
    expect(table.rows[0]).toMatch(/^MET-52\s+CLICK\s+Add to cart\s+\.btn-add-to-cart\s+3m\/1r$/)
    expect(table.rows[1]).toMatch(/^MET-7\s+PAGEVIEW\s+Checkout\s+\/checkout \(PATH\)\s+0m\/0r {2}\(archived\)$/)
  })
})

describe('buildCreateBody', () => {
  it('sends no projectId: the platform takes the project from the URL', () => {
    const body = buildCreateBody('CLICK', { selector: '.cta' }, 'Hero click')

    expect(body).toEqual({ type: 'CLICK', name: 'Hero click', description: undefined, cssSelector: '.cta', pageUrl: undefined })
    expect(body).not.toHaveProperty('projectId')
  })

  it('defaults a pageview match mode to SIMPLE and carries the value flag for custom metrics', () => {
    expect(buildCreateBody('PAGEVIEW', { urlMatch: '/thanks' }, 'Thanks')).toMatchObject({ urlMatchMode: 'SIMPLE' })
    expect(buildCreateBody('CUSTOM', { key: 'purchase', hasValue: true }, 'Purchase')).toMatchObject({
      eventKey: 'purchase',
      hasValueField: true,
    })
  })
})

describe('describeArchiveCascade (FU-36)', () => {
  it('names the experiments and flag rules an archive detached', () => {
    expect(
      describeArchiveCascade({ metric: {}, cascade: { experimentCount: 2, flagRuleCount: 1, bindingCount: 3 } }),
    ).toBe('Detached from 2 experiments and 1 flag rule. Unarchiving will not reattach it.')
  })

  it('names only what was detached, in the singular when there is one', () => {
    expect(describeArchiveCascade({ cascade: { experimentCount: 1, flagRuleCount: 0, bindingCount: 1 } })).toBe(
      'Detached from 1 experiment. Unarchiving will not reattach it.',
    )
    expect(describeArchiveCascade({ cascade: { experimentCount: 0, flagRuleCount: 4, bindingCount: 4 } })).toBe(
      'Detached from 4 flag rules. Unarchiving will not reattach it.',
    )
  })

  it('says nothing when nothing was detached or the answer has no counts', () => {
    expect(describeArchiveCascade({ cascade: { experimentCount: 0, flagRuleCount: 0, bindingCount: 0 } })).toBeNull()
    expect(describeArchiveCascade({ metric: {} })).toBeNull()
    expect(describeArchiveCascade(null)).toBeNull()
    expect(describeArchiveCascade({ cascade: { experimentCount: 'two' } })).toBeNull()
  })
})
