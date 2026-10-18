/**
 * Helpers shared by the `avsb metrics` subcommands. Kept separate from
 * `metrics.ts` so the command file stays small and so the helpers are
 * unit-testable in isolation.
 *
 * Spec: _specs/metric-model-redesign-spec.md §17
 */

import { ApiRequestError } from '../lib/apiError.js'
import { CliError } from '../lib/cliError.js'
import * as logger from '../lib/logger.js'
import { failCommand } from '../lib/output.js'
import { resolveProjectRefOrExit } from '../lib/projectRef.js'
import type {
  CliMetric,
  CliMetricType,
  CliUrlMatchMode,
  CreateMetricBody,
  UpdateMetricBody,
  CliMetricUsage,
} from '../types/metric.js'

export const URL_MATCH_MODES: readonly CliUrlMatchMode[] = [
  'SIMPLE',
  'EXACT',
  'PATH',
  'SUBSTRING',
  'PATTERN',
  'REGEX',
] as const

export const METRIC_TYPES: readonly CliMetricType[] = ['CLICK', 'PAGEVIEW', 'CUSTOM'] as const

export function normalizeType(raw: string): CliMetricType {
  const upper = raw.toUpperCase()
  if (!METRIC_TYPES.includes(upper as CliMetricType)) {
    failCommand(
      new CliError(
        'cli_usage',
        `Invalid --type "${raw}". Must be one of: ${METRIC_TYPES.join(' | ')}`,
      ),
    )
  }
  return upper as CliMetricType
}

export function normalizeMatchMode(raw: string): CliUrlMatchMode {
  const upper = raw.toUpperCase()
  if (!URL_MATCH_MODES.includes(upper as CliUrlMatchMode)) {
    failCommand(
      new CliError(
        'cli_usage',
        `Invalid --match-mode "${raw}". Must be one of: ${URL_MATCH_MODES.join(' | ')}`,
      ),
    )
  }
  return upper as CliUrlMatchMode
}

/**
 * Resolve the project short id for a command run.
 *
 * The rules (flag, then `.avsb-project.json`, then `.avsb.json`) live in
 * `lib/projectRef.ts` so every project-scoped command shares them; this wrapper
 * only turns a failure into the CLI's standard exit.
 */
export function resolveProjectShortId(opts: { project?: string }): number {
  return resolveProjectRefOrExit(opts).shortId
}

export function describeMetric(metric: CliMetric): string {
  if (metric.type === 'CLICK') return metric.cssSelector ?? '—'
  if (metric.type === 'PAGEVIEW') {
    const mode = metric.urlMatchMode ?? 'SIMPLE'
    return `${metric.urlMatch ?? '—'} (${mode})`
  }
  if (metric.type === 'CUSTOM') {
    return metric.hasValueField
      ? `${metric.eventKey ?? '—'} (with value)`
      : (metric.eventKey ?? '—')
  }
  return '—'
}

export function metricIdLabel(metric: CliMetric): string {
  return `MET-${metric.shortId}`
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + '…'
}

export function formatUsage(usage: CliMetricUsage | undefined): string {
  const exp = usage?.experimentCount ?? 0
  const rule = usage?.flagRuleCount ?? 0
  return `${exp}m/${rule}r`
}

export function printMetricDetails(metric: CliMetric): void {
  logger.line()
  logger.heading(metric.name)
  logger.label('ID', metricIdLabel(metric))
  logger.label('Type', metric.type)
  if (metric.description) logger.label('Description', metric.description)
  if (metric.type === 'CLICK') {
    logger.label('Selector', metric.cssSelector ?? '—')
    if (metric.pageUrl) logger.label('Page URL', metric.pageUrl)
  } else if (metric.type === 'PAGEVIEW') {
    logger.label('URL match', metric.urlMatch ?? '—')
    logger.label('Match mode', metric.urlMatchMode ?? 'SIMPLE')
  } else if (metric.type === 'CUSTOM') {
    logger.label('Key', metric.eventKey ?? '—')
    logger.label('Has value', metric.hasValueField ? 'yes' : 'no')
  }
  if (metric.archivedAt) logger.label('Archived', new Date(metric.archivedAt).toISOString())
  logger.line()
}

export interface CreateMetricOptions {
  project?: string
  type?: string
  name?: string
  description?: string
  selector?: string
  pageUrl?: string
  urlMatch?: string
  matchMode?: string
  key?: string
  hasValue?: boolean
}

export interface UpdateMetricOptions {
  project?: string
  name?: string
  description?: string
  selector?: string
  pageUrl?: string
  urlMatch?: string
  matchMode?: string
  key?: string
  hasValue?: boolean
}

export function buildCreateBody(
  type: CliMetricType,
  opts: CreateMetricOptions,
  name: string,
): CreateMetricBody {
  const description = opts.description ?? undefined
  if (type === 'CLICK') {
    if (!opts.selector) {
      failCommand(new CliError('cli_usage', 'CLICK metrics require --selector "<css>".'))
    }
    return {
      type: 'CLICK',
      name,
      description,
      cssSelector: opts.selector,
      pageUrl: opts.pageUrl ?? undefined,
    }
  }
  if (type === 'PAGEVIEW') {
    if (!opts.urlMatch) {
      failCommand(new CliError('cli_usage', 'PAGEVIEW metrics require --url-match "<pattern>".'))
    }
    const matchMode = opts.matchMode ? normalizeMatchMode(opts.matchMode) : 'SIMPLE'
    return {
      type: 'PAGEVIEW',
      name,
      description,
      urlMatch: opts.urlMatch,
      urlMatchMode: matchMode,
    }
  }
  // CUSTOM
  if (!opts.key) {
    failCommand(new CliError('cli_usage', 'CUSTOM metrics require --key "<eventKey>".'))
  }
  return {
    type: 'CUSTOM',
    name,
    description,
    eventKey: opts.key,
    hasValueField: opts.hasValue === true,
  }
}

export function buildUpdatePatch(opts: UpdateMetricOptions): UpdateMetricBody {
  const patch: UpdateMetricBody = {}
  if (opts.name !== undefined) patch.name = opts.name
  if (opts.description !== undefined) patch.description = opts.description
  if (opts.selector !== undefined) patch.cssSelector = opts.selector
  if (opts.pageUrl !== undefined) patch.pageUrl = opts.pageUrl
  if (opts.urlMatch !== undefined) patch.urlMatch = opts.urlMatch
  if (opts.matchMode !== undefined) patch.urlMatchMode = normalizeMatchMode(opts.matchMode)
  if (opts.key !== undefined) patch.eventKey = opts.key
  if (opts.hasValue !== undefined) patch.hasValueField = opts.hasValue
  return patch
}

/**
 * The metric bindings blocking a delete, by name.
 *
 * The route answers 409 with `metricsReferencing` alongside the message, and
 * the transport keeps those sibling fields on the error, so the real list is
 * available. The message-text fallback stays for anything that only sends prose.
 */
export function extractBindingsReferencing(err: unknown): string[] {
  if (err instanceof ApiRequestError) {
    const rows = err.details?.metricsReferencing
    if (Array.isArray(rows)) {
      const names = rows
        .map((row) =>
          typeof row === 'object' && row !== null && typeof (row as { name?: unknown }).name === 'string'
            ? (row as { name: string }).name
            : null,
        )
        .filter((name): name is string => name !== null)
      if (names.length > 0) return names
    }
  }

  if (!(err instanceof Error)) return []
  const match = err.message.match(/bindings?:\s*([^.]+)/i)
  return match ? [match[1].trim()] : []
}

export function isConflictError(err: unknown): boolean {
  if (err instanceof ApiRequestError) return err.status === 409
  if (!(err instanceof Error)) return false
  return /409|conflict|referenc/i.test(err.message)
}

// ── Reading the platform's answers ──────────────────────────
//
// The CLI used to read `data.metrics` off a list that answered `{ events }`
// and `data.metric` off a create that answered `{ event }`, so a list crashed
// with "Cannot read properties of undefined" and a create that had worked was
// reported as a failure (QA N4-3). The readers below check the shape first: a
// request that succeeded is never reported as failed because the answer was
// not the shape this CLI expected.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for a metric row as the platform sends it. */
export function isCliMetric(value: unknown): value is CliMetric {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.shortId === 'number' &&
    typeof value.name === 'string' &&
    typeof value.type === 'string'
  )
}

/** `{ metrics, usage }` from a list answer, or null when it is some other shape. */
export function readMetricList(
  data: unknown,
): { metrics: CliMetric[]; usage: Record<string, CliMetricUsage> } | null {
  if (!isRecord(data) || !Array.isArray(data.metrics)) return null
  const metrics = data.metrics.filter(isCliMetric)
  const usage = isRecord(data.usage) ? (data.usage as Record<string, CliMetricUsage>) : {}
  return { metrics, usage }
}

/** The metric from a create, update, archive or unarchive answer, or null. */
export function readMetric(data: unknown): CliMetric | null {
  return isRecord(data) && isCliMetric(data.metric) ? data.metric : null
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The line printed under a successful archive, naming the usage it detached:
 * archiving removes the metric from every experiment and flag rule that used
 * it, and unarchiving does not put it back, so the user should hear what
 * changed. Null when nothing was detached or the answer carries no counts.
 */
export function describeArchiveCascade(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.cascade)) return null
  const { experimentCount, flagRuleCount } = data.cascade
  const experiments = typeof experimentCount === 'number' ? experimentCount : 0
  const flagRules = typeof flagRuleCount === 'number' ? flagRuleCount : 0
  if (experiments === 0 && flagRules === 0) return null
  const parts = [
    experiments > 0 ? plural(experiments, 'experiment', 'experiments') : null,
    flagRules > 0 ? plural(flagRules, 'flag rule', 'flag rules') : null,
  ].filter((part): part is string => part !== null)
  return `Detached from ${parts.join(' and ')}. Unarchiving will not reattach it.`
}

/** The list as table lines: a heading and one row per metric. */
export function formatMetricTable(
  metrics: CliMetric[],
  usage: Record<string, CliMetricUsage>,
): { heading: string; rows: string[] } {
  const rows = metrics.map((metric) => ({
    id: metricIdLabel(metric),
    type: metric.type,
    name: truncate(metric.name, 32),
    definition: truncate(describeMetric(metric), 48),
    usage: formatUsage(usage[metric.id]),
    archived: metric.archivedAt != null,
  }))

  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    type: Math.max(4, ...rows.map((r) => r.type.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    definition: Math.max(10, ...rows.map((r) => r.definition.length)),
  }

  const heading = [
    'ID'.padEnd(widths.id),
    'Type'.padEnd(widths.type),
    'Name'.padEnd(widths.name),
    'Definition'.padEnd(widths.definition),
    'Usage',
  ].join('  ')

  return {
    heading,
    rows: rows.map((row) => {
      const line = [
        row.id.padEnd(widths.id),
        row.type.padEnd(widths.type),
        row.name.padEnd(widths.name),
        row.definition.padEnd(widths.definition),
        row.usage,
      ].join('  ')
      return row.archived ? `${line}  (archived)` : line
    }),
  }
}
