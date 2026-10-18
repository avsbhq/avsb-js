/**
 * `avsb metric-bindings` command group — manage saved/library metric bindings
 * (the analysis-side wrappers around metric tracking definitions).
 *
 * Calls the CLI-facing routes under
 * `/api/cli/projects/[shortId]/metric-bindings`. Helpers live in
 * `metric-bindings.helpers.ts` to keep this file focused on commander wiring.
 *
 * Spec: _specs/metric-model-redesign-spec.md §17 + §5.2
 */

import { Command } from 'commander'
import inquirer from 'inquirer'
import ora from 'ora'
import { ensureLoggedIn } from '../lib/config.js'
import { ApiClient } from '../lib/api.js'
import { CliError } from '../lib/cliError.js'
import { isInteractiveRun } from '../lib/interactive.js'
import * as logger from '../lib/logger.js'
import { parseLimitOption } from '../lib/listOptions.js'
import { startSpinner } from '../lib/outputMode.js'
import {
  beginCommand,
  emitJsonResult,
  failCommand,
  withOutputOptions,
} from '../lib/output.js'
import {
  resolveProjectShortId,
  normalizeMeasure,
  metricBindingIdLabel,
  printMetricBindingDetails,
  extractExperimentsReferencing,
  isConflictError,
  readMetricBinding,
  readMetricBindingList,
  formatMetricBindingTable,
} from './metric-bindings.helpers.js'
import {
  buildCreateMetricBindingBody,
  buildUpdateMetricBindingPatch,
  type CreateMetricBindingOptions,
  type UpdateMetricBindingOptions,
} from './metric-bindings.body.js'

// ── List ────────────────────────────────────────────────────

const metricBindingsListCommand = withOutputOptions(
  new Command('list')
    .description('List metric bindings for a project')
    .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
    .option('--library', 'Only show library (saved) metric bindings')
    .option('--search <text>', 'Case-insensitive name filter')
    .option('--include-archived', 'Include archived metric bindings')
    .option('--limit <n>', 'Max rows to return (1-500, default 200)'),
).action(
    async (opts: {
      project?: string
      library?: boolean
      search?: string
      includeArchived?: boolean
      limit?: string
      json?: boolean
      quiet?: boolean
    }) => {
      beginCommand('metric-bindings list', opts)
      const config = ensureLoggedIn()
      const shortId = resolveProjectShortId(opts)
      const limit = parseLimitOption(opts.limit, 500)

      const api = new ApiClient(config)
      const spinner = startSpinner('Fetching metric bindings...')

      let response
      try {
        response = await api.listMetricBindings(shortId, {
          library: opts.library,
          search: opts.search,
          includeArchived: opts.includeArchived,
          limit,
        })
        spinner.succeed(`Fetched metric bindings for PRJ-${shortId}`)
      } catch (err) {
        spinner.fail('Failed to fetch metric bindings')
        failCommand(err)
      }

      if (emitJsonResult(response.data)) return

      const metricBindings = readMetricBindingList(response.data)
      if (!metricBindings) {
        failCommand(
          new CliError('cli_failed', 'The platform answered in a shape this CLI does not read.', [
            'Upgrade the CLI with `npm install -g @avsbhq/cli`, or pass --json to see the raw answer.',
          ]),
        )
      }

      if (metricBindings.length === 0) {
        logger.line()
        logger.info(
          'No metric bindings yet. Create one with `avsb metric-bindings create --measure unique_conversions_per_visitor --metric <metricId> --name "..."`',
        )
        return
      }

      const table = formatMetricBindingTable(metricBindings)
      logger.line()
      logger.heading(table.heading)
      for (const row of table.rows) logger.line(row)
      logger.line()
    },
  )

// ── Create ──────────────────────────────────────────────────

const metricBindingsCreateCommand = new Command('create')
  .description('Create a new metric binding')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .option(
    '--measure <measure>',
    'Measure (UNIQUE_CONVERSIONS_PER_VISITOR | TOTAL_EVENTS | UNIQUE_VISITORS_WHO_FIRED | TOTAL_VALUE_PER_VISITOR | TOTAL_VALUE | PERCENTILE | RATE | COMPOSITE)',
  )
  .option('--direction <direction>', 'Direction (INCREASE | DECREASE)', 'INCREASE')
  .option('--name <name>', 'Display name')
  .option('--description <text>', 'Optional description')
  .option('--metric <metricId>', 'Source metric: MET-17, 17 or the long id (required for single-metric measures)')
  .option('--numerator-metric <metricId>', 'Numerator metric (required for RATE)')
  .option('--denominator-metric <metricId>', 'Denominator metric (required for RATE)')
  .option('--composition <json>', 'COMPOSITE components as a JSON array of { metricId, weight }, where metricId names a metric binding')
  .option(
    '--component <bindingId:weight>',
    'Repeatable COMPOSITE component, a metric binding and its weight (e.g. --component MBD-8:0.5 --component MBD-9:0.5)',
    (value: string, prev: string[] = []) => prev.concat(value),
    [] as string[],
  )
  .option('--percentile <n>', 'Percentile (required for PERCENTILE measure, 0 < n < 100)')
  .option('--value-source <name>', 'Numeric field on the metric (value/percentile measures)', 'value')
  .option('--winsorize-upper <pct>', 'Upper winsorization percentile (enables winsorization)')
  .option('--winsorize-lower <pct>', 'Lower winsorization percentile (enables winsorization)')
  .action(async (opts: CreateMetricBindingOptions) => {
    if (!opts.measure) {
      failCommand(new CliError('cli_usage', '--measure is required.'))
    }
    if (!opts.name) {
      failCommand(new CliError('cli_usage', '--name is required'))
    }

    const config = ensureLoggedIn()
    const shortId = resolveProjectShortId(opts)
    const measure = normalizeMeasure(opts.measure)

    const api = new ApiClient(config)
    const body = buildCreateMetricBindingBody(measure, opts, opts.name)
    const spinner = ora('Creating metric binding...').start()

    let response
    try {
      response = await api.createMetricBinding(shortId, body)
    } catch (err) {
      spinner.fail('Failed to create metric binding')
      failCommand(err)
    }

    // The request worked from here on: never report it as failed.
    const metricBinding = readMetricBinding(response.data)
    if (!metricBinding) {
      spinner.warn('Metric binding created. Run `avsb metric-bindings list` to see it.')
      return
    }
    spinner.succeed(`Metric binding created: ${metricBinding.name} (${metricBindingIdLabel(metricBinding)})`)
    printMetricBindingDetails(metricBinding)
  })

// ── Update ──────────────────────────────────────────────────

const metricBindingsUpdateCommand = new Command('update')
  .argument('<metricBindingId>', 'Metric binding ID (cuid or numeric short ID)')
  .description('Update a metric binding')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .option('--name <name>', 'New display name')
  .option('--description <text>', 'New description')
  .option('--direction <direction>', 'New direction (INCREASE | DECREASE)')
  .option('--metric <metricId>', 'New source metric')
  .option('--numerator-metric <metricId>', 'New numerator metric (RATE)')
  .option('--denominator-metric <metricId>', 'New denominator metric (RATE)')
  .option('--composition <json>', 'New COMPOSITE composition as JSON array of { metricId,weight}')
  .option(
    '--component <bindingId:weight>',
    'Repeatable COMPOSITE component, a metric binding and its weight (replaces the composition)',
    (value: string, prev: string[] = []) => prev.concat(value),
    [] as string[],
  )
  .option('--percentile <n>', 'New percentile (PERCENTILE measure)')
  .option('--value-source <name>', 'New value source field name')
  .option('--winsorize-upper <pct>', 'New upper winsorization percentile')
  .option('--winsorize-lower <pct>', 'New lower winsorization percentile')
  .option('--library', 'Mark as a library metric binding')
  .option('--no-library', 'Mark as a non-library metric binding')
  .action(async (metricBindingId: string, opts: UpdateMetricBindingOptions) => {
    const config = ensureLoggedIn()
    const shortId = resolveProjectShortId(opts)
    const patch = buildUpdateMetricBindingPatch(opts)

    if (Object.keys(patch).length === 0) {
      failCommand(
        new CliError('cli_usage', 'No update fields provided. Pass at least one of --name, --description, --direction, etc.'),
      )
    }

    const api = new ApiClient(config)
    const spinner = ora('Updating metric binding...').start()

    let response
    try {
      response = await api.updateMetricBinding(shortId, metricBindingId, patch)
    } catch (err) {
      spinner.fail('Failed to update metric binding')
      failCommand(err)
    }
    const metricBinding = readMetricBinding(response.data)
    if (!metricBinding) {
      spinner.warn(`Metric binding ${metricBindingId} updated.`)
      return
    }
    spinner.succeed(`Metric binding updated: ${metricBinding.name} (${metricBindingIdLabel(metricBinding)})`)
    printMetricBindingDetails(metricBinding)
  })

// ── Archive / Unarchive ─────────────────────────────────────

const metricBindingsArchiveCommand = new Command('archive')
  .argument('<metricBindingId>', 'Metric binding ID')
  .description('Archive a metric binding (soft-delete, preserves history)')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .action(async (metricBindingId: string, opts: { project?: string }) => {
    const config = ensureLoggedIn()
    const shortId = resolveProjectShortId(opts)
    const api = new ApiClient(config)
    const spinner = ora('Archiving metric binding...').start()

    let response
    try {
      response = await api.archiveMetricBinding(shortId, metricBindingId)
    } catch (err) {
      spinner.fail('Failed to archive metric binding')
      failCommand(err)
    }
    const metricBinding = readMetricBinding(response.data)
    spinner.succeed(
      metricBinding
        ? `Metric binding archived: ${metricBinding.name} (${metricBindingIdLabel(metricBinding)})`
        : `Metric binding ${metricBindingId} archived`,
    )
  })

const metricBindingsUnarchiveCommand = new Command('unarchive')
  .argument('<metricBindingId>', 'Metric binding ID')
  .description('Restore an archived metric binding')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .action(async (metricBindingId: string, opts: { project?: string }) => {
    const config = ensureLoggedIn()
    const shortId = resolveProjectShortId(opts)
    const api = new ApiClient(config)
    const spinner = ora('Restoring metric binding...').start()

    let response
    try {
      response = await api.unarchiveMetricBinding(shortId, metricBindingId)
    } catch (err) {
      spinner.fail('Failed to unarchive metric binding')
      failCommand(err)
    }
    const metricBinding = readMetricBinding(response.data)
    spinner.succeed(
      metricBinding
        ? `Metric binding restored from archive: ${metricBinding.name} (${metricBindingIdLabel(metricBinding)})`
        : `Metric binding ${metricBindingId} restored from archive`,
    )
  })

// ── Delete ──────────────────────────────────────────────────

const metricBindingsDeleteCommand = new Command('delete')
  .argument('<metricBindingId>', 'Metric binding ID')
  .description('Delete a metric binding (rejected if experiments still attach it)')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (metricBindingId: string, opts: { project?: string; force?: boolean }) => {
    const config = ensureLoggedIn()
    const shortId = resolveProjectShortId(opts)
    const api = new ApiClient(config)

    if (!opts.force) {
      if (!isInteractiveRun()) {
        failCommand(
          new CliError('cli_usage', `Deleting metric binding ${metricBindingId} needs a confirmation this run cannot ask for.`, [
            `Pass -f to delete without asking: \`avsb metric-bindings delete ${metricBindingId} -f\``,
          ]),
        )
      }
      const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
        {
          type: 'confirm',
          name: 'proceed',
          message: `Delete metric binding ${metricBindingId}? Experiments still attaching it will block deletion.`,
          default: false,
        },
      ])
      if (!proceed) {
        logger.info('Delete aborted.')
        return
      }
    }

    const spinner = ora('Deleting metric binding...').start()

    try {
      await api.deleteMetricBinding(shortId, metricBindingId)
      spinner.succeed(`Metric binding deleted: ${metricBindingId}`)
    } catch (err) {
      spinner.fail('Failed to delete metric binding')
      if (isConflictError(err)) {
        const refs = extractExperimentsReferencing(err)
        if (refs.length > 0) logger.error(`Attached to ${refs.join(', ')}.`)
        logger.info(
          `Tip: run \`avsb metric-bindings archive ${metricBindingId}\` instead to hide it without losing history.`,
        )
      }
      failCommand(err)
    }
  })

// ── Parent command ──────────────────────────────────────────

export const metricBindingsCommand = new Command('metric-bindings')
  .description('Manage saved/library metric bindings')
  .addCommand(metricBindingsListCommand)
  .addCommand(metricBindingsCreateCommand)
  .addCommand(metricBindingsUpdateCommand)
  .addCommand(metricBindingsArchiveCommand)
  .addCommand(metricBindingsUnarchiveCommand)
  .addCommand(metricBindingsDeleteCommand)
