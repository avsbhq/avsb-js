/**
 * Turning `avsb metric-bindings create` / `update` flags into a wire body.
 *
 * Split out of `metric-bindings.helpers.ts` to keep both files inside the size
 * limit: this half is pure input parsing (composition, winsorization, per-measure
 * required fields), the other half is presentation.
 */

import { CliError } from '../lib/cliError.js'
import { failCommand } from '../lib/output.js'
import { normalizeDirection, SINGLE_METRIC_MEASURES, VALUE_MEASURES } from './metric-bindings.helpers.js'
import type {
  CliCompositionEntry,
  CliMeasure,
  CliWinsorization,
  CreateMetricBindingBody,
  UpdateMetricBindingBody,
} from '../types/metricBinding.js'

export interface CreateMetricBindingOptions {
  project?: string
  measure?: string
  direction?: string
  name?: string
  description?: string
  metric?: string
  numeratorMetric?: string
  denominatorMetric?: string
  composition?: string
  component?: string[]
  percentile?: string
  valueSource?: string
  winsorizeUpper?: string
  winsorizeLower?: string
}

export interface UpdateMetricBindingOptions {
  project?: string
  name?: string
  description?: string
  direction?: string
  metric?: string
  numeratorMetric?: string
  denominatorMetric?: string
  composition?: string
  component?: string[]
  percentile?: string
  valueSource?: string
  winsorizeUpper?: string
  winsorizeLower?: string
  library?: boolean
}

function parseComposition(opts: { composition?: string; component?: string[] }): CliCompositionEntry[] | undefined {
  if (opts.composition) {
    let parsed: unknown
    try {
      parsed = JSON.parse(opts.composition)
    } catch {
      failCommand(
        new CliError(
          'cli_usage',
          '--composition must be a JSON array (e.g. \'[{"metricId":"b1","weight":1}]\').',
        ),
      )
    }
    if (!Array.isArray(parsed)) {
      failCommand(
        new CliError('cli_usage', '--composition JSON must be an array of {metricId, weight} objects.'),
      )
    }
    return parsed.map((entry: unknown, idx) => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as { metricId?: unknown }).metricId !== 'string' ||
        typeof (entry as { weight?: unknown }).weight !== 'number'
      ) {
        failCommand(
          new CliError(
            'cli_usage',
            `--composition[${idx}] must have shape {metricId: string, weight: number}.`,
          ),
        )
      }
      const e = entry as { metricId: string; weight: number }
      return { metricId: e.metricId, weight: e.weight }
    })
  }
  if (opts.component && opts.component.length > 0) {
    return opts.component.map((raw, idx) => {
      const [metricId, weightStr] = raw.split(':')
      const weight = Number(weightStr)
      if (!metricId || !Number.isFinite(weight)) {
        failCommand(
          new CliError('cli_usage', `--component[${idx}] must be in the form <metricId>:<weight>.`),
        )
      }
      return { metricId, weight }
    })
  }
  return undefined
}

function parseWinsorization(opts: {
  winsorizeUpper?: string
  winsorizeLower?: string
}): CliWinsorization | undefined {
  if (opts.winsorizeUpper === undefined && opts.winsorizeLower === undefined) return undefined
  const upper = opts.winsorizeUpper !== undefined ? Number(opts.winsorizeUpper) : 99
  const lower = opts.winsorizeLower !== undefined ? Number(opts.winsorizeLower) : 0
  if (!Number.isFinite(upper) || !Number.isFinite(lower)) {
    failCommand(
      new CliError(
        'cli_usage',
        '--winsorize-upper / --winsorize-lower must be numeric percentiles (0-100).',
      ),
    )
  }
  return { enabled: true, upperPercentile: upper, lowerPercentile: lower }
}

/**
 * The create body. No `projectId`: the platform takes the project from the URL,
 * so the CLI no longer fetches the project first just to echo its id back.
 * Metric ids may be any form the CLI shows (`MET-17`, `17`, a long id); the
 * platform resolves them.
 */
export function buildCreateMetricBindingBody(
  measure: CliMeasure,
  opts: CreateMetricBindingOptions,
  name: string,
): CreateMetricBindingBody {
  const direction = opts.direction ? normalizeDirection(opts.direction) : 'INCREASE'
  const body: CreateMetricBindingBody = {
    name,
    description: opts.description ?? undefined,
    measure,
    direction,
    isLibrary: true,
  }
  const winsor = parseWinsorization(opts)
  if (winsor) body.winsorization = winsor

  if (measure === 'RATE') {
    if (!opts.numeratorMetric || !opts.denominatorMetric) {
      failCommand(
        new CliError(
          'cli_usage',
          'RATE metric bindings require --numerator-metric <metricId> and --denominator-metric <metricId>.',
        ),
      )
    }
    body.numeratorMetricId = opts.numeratorMetric
    body.denominatorMetricId = opts.denominatorMetric
    return body
  }

  if (measure === 'COMPOSITE') {
    const composition = parseComposition(opts)
    if (!composition || composition.length < 2) {
      failCommand(
        new CliError(
          'cli_usage',
          'COMPOSITE metric bindings require at least 2 components via --composition <json> or repeated --component <metricId>:<weight>.',
        ),
      )
    }
    body.composition = composition
    return body
  }

  if (SINGLE_METRIC_MEASURES.includes(measure)) {
    if (!opts.metric) {
      failCommand(new CliError('cli_usage', `Measure ${measure} requires --metric <metricId>.`))
    }
    body.metricId = opts.metric
  }

  if (measure === 'PERCENTILE') {
    if (opts.percentile === undefined) {
      failCommand(
        new CliError(
          'cli_usage',
          'PERCENTILE metric bindings require --percentile <number> (0 < p < 100).',
        ),
      )
    }
    const p = Number(opts.percentile)
    if (!Number.isFinite(p) || p <= 0 || p >= 100) {
      failCommand(
        new CliError('cli_usage', '--percentile must be a number strictly between 0 and 100.'),
      )
    }
    body.percentile = p
  }

  if (VALUE_MEASURES.includes(measure)) {
    body.valueSource = opts.valueSource ?? 'value'
  }

  return body
}

export function buildUpdateMetricBindingPatch(opts: UpdateMetricBindingOptions): UpdateMetricBindingBody {
  const patch: UpdateMetricBindingBody = {}
  if (opts.name !== undefined) patch.name = opts.name
  if (opts.description !== undefined) patch.description = opts.description
  if (opts.direction !== undefined) patch.direction = normalizeDirection(opts.direction)
  if (opts.metric !== undefined) patch.metricId = opts.metric
  if (opts.numeratorMetric !== undefined) patch.numeratorMetricId = opts.numeratorMetric
  if (opts.denominatorMetric !== undefined) patch.denominatorMetricId = opts.denominatorMetric
  if (opts.percentile !== undefined) {
    // Same bound and same message as the create path above. The server enforces
    // 0 < p < 100 either way, so a looser check here only meant the refusal
    // arrived as a round trip and an API error instead of a usage error naming
    // the flag.
    const p = Number(opts.percentile)
    if (!Number.isFinite(p) || p <= 0 || p >= 100) {
      failCommand(
        new CliError('cli_usage', '--percentile must be a number strictly between 0 and 100.'),
      )
    }
    patch.percentile = p
  }
  if (opts.valueSource !== undefined) patch.valueSource = opts.valueSource
  if (opts.library !== undefined) patch.isLibrary = opts.library

  const composition = parseComposition(opts)
  if (composition) patch.composition = composition

  const winsor = parseWinsorization(opts)
  if (winsor) patch.winsorization = winsor

  return patch
}
