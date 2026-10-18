/**
 * Helpers shared by the `avsb metric-bindings` subcommands. Kept separate
 * from `metric-bindings.ts` so the command file stays small and so the
 * helpers are unit-testable in isolation.
 *
 * Spec: _specs/metric-model-redesign-spec.md §17, §5.2
 */

import { ApiRequestError } from '../lib/apiError.js'
import { CliError } from '../lib/cliError.js'
import * as logger from '../lib/logger.js'
import { failCommand } from '../lib/output.js'
import { resolveProjectRefOrExit } from '../lib/projectRef.js'
import type {
  CliMetricBinding,
  CliMeasure,
  CliMetricBindingDirection,
  CliMetricBindingMetricRef,
} from '../types/metricBinding.js'

export const MEASURES: readonly CliMeasure[] = [
  'UNIQUE_CONVERSIONS_PER_VISITOR',
  'TOTAL_EVENTS',
  'UNIQUE_VISITORS_WHO_FIRED',
  'TOTAL_VALUE_PER_VISITOR',
  'TOTAL_VALUE',
  'PERCENTILE',
  'RATE',
  'COMPOSITE',
] as const

export const DIRECTIONS: readonly CliMetricBindingDirection[] = ['INCREASE', 'DECREASE'] as const

/**
 * Measures that reference a single metric via `metricId`. Used to decide
 * which flag is required at create time.
 */
export const SINGLE_METRIC_MEASURES: readonly CliMeasure[] = [
  'UNIQUE_CONVERSIONS_PER_VISITOR',
  'TOTAL_EVENTS',
  'UNIQUE_VISITORS_WHO_FIRED',
  'TOTAL_VALUE_PER_VISITOR',
  'TOTAL_VALUE',
  'PERCENTILE',
] as const

/** Measures whose numbers come from an event's value field. */
export const VALUE_MEASURES: readonly CliMeasure[] = [
  'TOTAL_VALUE_PER_VISITOR',
  'TOTAL_VALUE',
  'PERCENTILE',
] as const

export function normalizeMeasure(raw: string): CliMeasure {
  const upper = raw.toUpperCase().replace(/-/g, '_')
  if (!MEASURES.includes(upper as CliMeasure)) {
    failCommand(
      new CliError('cli_usage', `Invalid --measure "${raw}". Must be one of: ${MEASURES.join(' | ')}`),
    )
  }
  return upper as CliMeasure
}

export function normalizeDirection(raw: string): CliMetricBindingDirection {
  const upper = raw.toUpperCase()
  if (!DIRECTIONS.includes(upper as CliMetricBindingDirection)) {
    failCommand(
      new CliError(
        'cli_usage',
        `Invalid --direction "${raw}". Must be one of: ${DIRECTIONS.join(' | ')}`,
      ),
    )
  }
  return upper as CliMetricBindingDirection
}

/**
 * Resolve the project short id for a command run. The rules live in
 * `lib/projectRef.ts` so every project-scoped command shares them.
 */
export function resolveProjectShortId(opts: { project?: string }): number {
  return resolveProjectRefOrExit(opts).shortId
}

export function metricBindingIdLabel(binding: CliMetricBinding): string {
  return `MBD-${binding.shortId}`
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + '…'
}

// ── Sentence rendering (local copy of app/_lib/measure/sentence.ts so the
// CLI can ship as a standalone package without importing from the app).

function metricLabel(metric: CliMetricBindingMetricRef | null | undefined): string {
  if (!metric) return 'a metric'
  if (metric.type === 'CLICK') {
    const selector = metric.cssSelector?.trim()
    return selector ? `${metric.name} (${selector})` : metric.name
  }
  if (metric.type === 'PAGEVIEW') {
    const match = metric.urlMatch?.trim()
    return match ? `${metric.name} (${match})` : metric.name
  }
  const key = metric.eventKey?.trim()
  return key ? `${metric.name} (${key})` : metric.name
}

function formatPercentile(raw: number | null | undefined): string {
  if (raw == null) return 'percentile'
  if (!Number.isFinite(raw)) return 'percentile'
  if (Number.isInteger(raw)) return `p${raw}`
  return `p${raw.toFixed(1)}`
}

function measurePhrase(binding: CliMetricBinding): string {
  switch (binding.measure) {
    case 'UNIQUE_CONVERSIONS_PER_VISITOR':
      return 'unique conversions per visitor'
    case 'TOTAL_EVENTS':
      return 'total events'
    case 'UNIQUE_VISITORS_WHO_FIRED':
      return 'unique visitors who fired'
    case 'TOTAL_VALUE_PER_VISITOR':
      return `total ${binding.valueSource ?? 'value'} per visitor`
    case 'TOTAL_VALUE':
      return `total ${binding.valueSource ?? 'value'}`
    case 'PERCENTILE': {
      const p = formatPercentile(binding.percentile)
      const source = binding.valueSource ?? 'value'
      return `${p} of ${source}`
    }
    case 'RATE':
      return 'rate of'
    case 'COMPOSITE':
      return 'composite score'
  }
}

export function renderMetricBindingSentence(binding: CliMetricBinding): string {
  const direction = binding.direction === 'DECREASE' ? 'Decrease' : 'Increase'

  if (binding.measure === 'RATE') {
    const num = metricLabel(binding.numeratorMetric)
    const den = metricLabel(binding.denominatorMetric)
    return `${direction} in ${measurePhrase(binding)} ${num} per ${den}.`
  }

  if (binding.measure === 'COMPOSITE') {
    const components = binding.composition ?? []
    if (components.length === 0) {
      return `${direction} in ${measurePhrase(binding)}.`
    }
    const total = components.reduce((s, c) => s + (Number.isFinite(c.weight) ? c.weight : 0), 0)
    const formatted = components
      .map((c) => {
        const pct = total > 0 ? Math.round((c.weight / total) * 100) : 0
        return `${pct}% ${c.metricId}`
      })
      .join(', ')
    return `${direction} in ${measurePhrase(binding)} of: ${formatted}.`
  }

  return `${direction} in ${measurePhrase(binding)} for ${metricLabel(binding.metric)}.`
}

export function measureBadge(measure: CliMeasure): string {
  switch (measure) {
    case 'UNIQUE_CONVERSIONS_PER_VISITOR':
      return 'Unique conv./visitor'
    case 'TOTAL_EVENTS':
      return 'Total events'
    case 'UNIQUE_VISITORS_WHO_FIRED':
      return 'Unique visitors'
    case 'TOTAL_VALUE_PER_VISITOR':
      return 'Value/visitor'
    case 'TOTAL_VALUE':
      return 'Total value'
    case 'PERCENTILE':
      return 'Percentile'
    case 'RATE':
      return 'Rate'
    case 'COMPOSITE':
      return 'Composite'
  }
}

export function printMetricBindingDetails(binding: CliMetricBinding): void {
  logger.line()
  logger.heading(binding.name)
  logger.label('ID', metricBindingIdLabel(binding))
  logger.label('Measure', measureBadge(binding.measure))
  logger.label('Direction', binding.direction)
  if (binding.description) logger.label('Description', binding.description)
  logger.label('Library', binding.isLibrary ? 'yes' : 'no')
  if (binding.metric) logger.label('Metric', `${binding.metric.name} (MET-${binding.metric.shortId})`)
  if (binding.numeratorMetric) {
    logger.label('Numerator', `${binding.numeratorMetric.name} (MET-${binding.numeratorMetric.shortId})`)
  }
  if (binding.denominatorMetric) {
    logger.label(
      'Denominator',
      `${binding.denominatorMetric.name} (MET-${binding.denominatorMetric.shortId})`,
    )
  }
  if (binding.valueSource) logger.label('Value source', binding.valueSource)
  if (binding.percentile != null) logger.label('Percentile', String(binding.percentile))
  if (binding.composition && binding.composition.length > 0) {
    const desc = binding.composition.map((c) => `${c.metricId}@${c.weight}`).join(', ')
    logger.label('Composition', desc)
  }
  if (binding.winsorization?.enabled) {
    logger.label(
      'Winsorization',
      `${binding.winsorization.lowerPercentile}-${binding.winsorization.upperPercentile}%`,
    )
  }
  if (binding.archivedAt) logger.label('Archived', new Date(binding.archivedAt).toISOString())
  logger.line()
}

/**
 * The experiments blocking a delete, by name.
 *
 * The route answers 409 with `experimentsReferencing` alongside the message and
 * the transport keeps those sibling fields, so the real list is available. The
 * message-text fallback stays for anything that only sends prose.
 */
export function extractExperimentsReferencing(err: unknown): string[] {
  if (err instanceof ApiRequestError) {
    const rows = err.details?.experimentsReferencing
    if (Array.isArray(rows)) {
      const names = rows
        .map((row) =>
          typeof row === 'object' &&
          row !== null &&
          typeof (row as { name?: unknown }).name === 'string'
            ? (row as { name: string }).name
            : null,
        )
        .filter((name): name is string => name !== null)
      if (names.length > 0) return names
    }
  }

  if (!(err instanceof Error)) return []
  const match = err.message.match(/experiments?:?\s*([^.]+)/i)
  return match ? [match[1].trim()] : []
}

export function isConflictError(err: unknown): boolean {
  if (err instanceof ApiRequestError) return err.status === 409
  if (!(err instanceof Error)) return false
  return /409|conflict|attached|referenc/i.test(err.message)
}

// ── Reading the platform's answers ──────────────────────────
//
// The CLI read `data.metricBinding` off answers that said `{ metric }`, so a
// create or update that had worked printed "Failed to create metric binding"
// and exited 1, and a script that retried made duplicates (QA N4-4). The
// readers check the shape first, so a request that succeeded is never
// reported as failed because of how the answer was worded.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for a metric binding row as the platform sends it. */
export function isCliMetricBinding(value: unknown): value is CliMetricBinding {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.shortId === 'number' &&
    typeof value.name === 'string' &&
    typeof value.measure === 'string'
  )
}

/** The bindings from a list answer, or null when it is some other shape. */
export function readMetricBindingList(data: unknown): CliMetricBinding[] | null {
  if (!isRecord(data) || !Array.isArray(data.metricBindings)) return null
  return data.metricBindings.filter(isCliMetricBinding)
}

/** The binding from a create, update, archive or unarchive answer, or null. */
export function readMetricBinding(data: unknown): CliMetricBinding | null {
  return isRecord(data) && isCliMetricBinding(data.metricBinding) ? data.metricBinding : null
}

/** The list as table lines: a heading and one row per binding. */
export function formatMetricBindingTable(bindings: CliMetricBinding[]): { heading: string; rows: string[] } {
  const rows = bindings.map((binding) => ({
    id: metricBindingIdLabel(binding),
    measure: measureBadge(binding.measure),
    name: truncate(binding.name, 28),
    sentence: truncate(renderMetricBindingSentence(binding), 64),
    archived: binding.archivedAt != null,
  }))

  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    measure: Math.max(7, ...rows.map((r) => r.measure.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
  }

  return {
    heading: ['ID'.padEnd(widths.id), 'Measure'.padEnd(widths.measure), 'Name'.padEnd(widths.name), 'Sentence'].join('  '),
    rows: rows.map((row) => {
      const line = [row.id.padEnd(widths.id), row.measure.padEnd(widths.measure), row.name.padEnd(widths.name), row.sentence].join('  ')
      return row.archived ? `${line}  (archived)` : line
    }),
  }
}
