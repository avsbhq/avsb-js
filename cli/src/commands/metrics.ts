/**
 * `avsb metrics` command group — manage metric tracking definitions.
 *
 * Calls the CLI-facing metric routes under
 * `/api/cli/projects/[shortId]/metrics`. Helpers live in
 * `metrics.helpers.ts` to keep this file focused on commander wiring.
 *
 * Spec: _specs/metric-model-redesign-spec.md §17 + §5.1
 */

import { Command } from 'commander'
import inquirer from 'inquirer'
import ora from 'ora'
import { ensureLoggedIn } from '../lib/config.js'
import { ApiClient } from '../lib/api.js'
import { CliError } from '../lib/cliError.js'
import { isInteractiveRun } from '../lib/interactive.js'
import * as logger from '../lib/logger.js'
import { startSpinner } from '../lib/outputMode.js'
import {
  beginCommand,
  emitJsonResult,
  failCommand,
  withOutputOptions,
} from '../lib/output.js'
import {
  resolveProjectShortId,
  normalizeType,
  buildCreateBody,
  buildUpdatePatch,
  metricIdLabel,
  printMetricDetails,
  extractBindingsReferencing,
  isConflictError,
  readMetric,
  readMetricList,
  formatMetricTable,
  describeArchiveCascade,
  type CreateMetricOptions,
  type UpdateMetricOptions,
} from './metrics.helpers.js'

// ── List ────────────────────────────────────────────────────

const metricsListCommand = withOutputOptions(
  new Command('list')
    .description('List metrics for a project')
    .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
    .option('--type <type>', 'Filter by metric type (CLICK | PAGEVIEW | CUSTOM)')
    .option('--include-archived', 'Include archived metrics'),
)
  .action(async (opts: {
    project?: string
    type?: string
    includeArchived?: boolean
    json?: boolean
    quiet?: boolean
  }) => {
    beginCommand('metrics list', opts)
    const config = ensureLoggedIn()
    const shortId = resolveProjectShortId(opts)
    const type = opts.type ? normalizeType(opts.type) : undefined

    const api = new ApiClient(config)
    const spinner = startSpinner('Fetching metrics...')

    let response
    try {
      response = await api.listMetrics(shortId, { type, includeArchived: opts.includeArchived })
      spinner.succeed(`Fetched metrics for PRJ-${shortId}`)
    } catch (err) {
      spinner.fail('Failed to fetch metrics')
      failCommand(err)
    }

    // The server's own body, unchanged: `data` is what the platform returned,
    // never a shape the CLI composed.
    if (emitJsonResult(response.data)) return

    const list = readMetricList(response.data)
    if (!list) {
      failCommand(
        new CliError('cli_failed', 'The platform answered in a shape this CLI does not read.', [
          'Upgrade the CLI with `npm install -g @avsbhq/cli`, or pass --json to see the raw answer.',
        ]),
      )
    }

    if (list.metrics.length === 0) {
      logger.line()
      logger.info(
        'No metrics yet. Create one with `avsb metrics create --type click --name "..." --selector ".cta"`',
      )
      return
    }

    const table = formatMetricTable(list.metrics, list.usage)
    logger.line()
    logger.heading(table.heading)
    for (const row of table.rows) logger.line(row)
    logger.line()
  })

// ── Create ──────────────────────────────────────────────────

const metricsCreateCommand = new Command('create')
  .description('Create a new metric')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .option('--type <type>', 'Metric type (CLICK | PAGEVIEW | CUSTOM)')
  .option('--name <name>', 'Display name')
  .option('--description <text>', 'Optional description')
  .option('--selector <selector>', 'CSS selector (CLICK only)')
  .option('--page-url <url>', 'Page URL filter (CLICK only)')
  .option('--url-match <pattern>', 'URL match pattern (PAGEVIEW only)')
  .option('--match-mode <mode>', 'URL match mode for PAGEVIEW (SIMPLE | EXACT | PATH | SUBSTRING | PATTERN | REGEX)')
  .option('--key <key>', 'Metric key (CUSTOM only)')
  .option('--has-value', 'Toggle value-field tracking on a CUSTOM metric')
  .action(async (opts: CreateMetricOptions) => {
    if (!opts.type) {
      failCommand(new CliError('cli_usage', '--type is required (CLICK | PAGEVIEW | CUSTOM)'))
    }
    if (!opts.name) {
      failCommand(new CliError('cli_usage', '--name is required'))
    }

    const config = ensureLoggedIn()
    const shortId = resolveProjectShortId(opts)
    const type = normalizeType(opts.type)
    const body = buildCreateBody(type, opts, opts.name)

    const api = new ApiClient(config)
    const spinner = ora('Creating metric...').start()

    let response
    try {
      response = await api.createMetric(shortId, body)
    } catch (err) {
      spinner.fail('Failed to create metric')
      failCommand(err)
    }

    // The request worked from here on; an unreadable answer is not a failure.
    const metric = readMetric(response.data)
    if (!metric) {
      spinner.warn('Metric created. Run `avsb metrics list` to see it.')
      return
    }
    spinner.succeed(`Metric created: ${metric.name} (${metricIdLabel(metric)})`)
    printMetricDetails(metric)
  })

// ── Update ──────────────────────────────────────────────────

const metricsUpdateCommand = new Command('update')
  .argument('<metricId>', 'Metric ID (cuid or numeric short ID)')
  .description('Update a metric')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .option('--name <name>', 'New display name')
  .option('--description <text>', 'New description')
  .option('--selector <selector>', 'New CSS selector (CLICK)')
  .option('--page-url <url>', 'New page URL filter (CLICK)')
  .option('--url-match <pattern>', 'New URL match pattern (PAGEVIEW)')
  .option('--match-mode <mode>', 'New URL match mode (PAGEVIEW)')
  .option('--key <key>', 'New metric key (CUSTOM)')
  .option('--has-value', 'Enable value-field tracking (CUSTOM)')
  .option('--no-has-value', 'Disable value-field tracking (CUSTOM)')
  .action(async (metricId: string, opts: UpdateMetricOptions) => {
    const config = ensureLoggedIn()
    const shortId = resolveProjectShortId(opts)
    const patch = buildUpdatePatch(opts)

    if (Object.keys(patch).length === 0) {
      failCommand(
        new CliError(
          'cli_usage',
          'No update fields provided. Pass at least one of --name, --description, --selector, etc.',
        ),
      )
    }

    const api = new ApiClient(config)
    const spinner = ora('Updating metric...').start()

    let response
    try {
      response = await api.updateMetric(shortId, metricId, patch)
    } catch (err) {
      spinner.fail('Failed to update metric')
      failCommand(err)
    }
    const metric = readMetric(response.data)
    if (!metric) {
      spinner.warn(`Metric ${metricId} updated.`)
      return
    }
    spinner.succeed(`Metric updated: ${metric.name} (${metricIdLabel(metric)})`)
    printMetricDetails(metric)
  })

// ── Archive / Unarchive ─────────────────────────────────────

const metricsArchiveCommand = new Command('archive')
  .argument('<metricId>', 'Metric ID')
  .description('Archive a metric (soft-delete, preserves history)')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .action(async (metricId: string, opts: { project?: string }) => {
    const config = ensureLoggedIn()
    const shortId = resolveProjectShortId(opts)
    const api = new ApiClient(config)
    const spinner = ora('Archiving metric...').start()

    let response
    try {
      response = await api.archiveMetric(shortId, metricId)
    } catch (err) {
      spinner.fail('Failed to archive metric')
      failCommand(err)
    }
    const metric = readMetric(response.data)
    spinner.succeed(metric ? `Metric archived: ${metric.name} (${metricIdLabel(metric)})` : `Metric ${metricId} archived`)
    const cascade = describeArchiveCascade(response.data)
    if (cascade) logger.info(cascade)
  })

const metricsUnarchiveCommand = new Command('unarchive')
  .argument('<metricId>', 'Metric ID')
  .description('Restore an archived metric')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .action(async (metricId: string, opts: { project?: string }) => {
    const config = ensureLoggedIn()
    const shortId = resolveProjectShortId(opts)
    const api = new ApiClient(config)
    const spinner = ora('Restoring metric...').start()

    let response
    try {
      response = await api.unarchiveMetric(shortId, metricId)
    } catch (err) {
      spinner.fail('Failed to unarchive metric')
      failCommand(err)
    }
    const metric = readMetric(response.data)
    spinner.succeed(
      metric ? `Metric restored from archive: ${metric.name} (${metricIdLabel(metric)})` : `Metric ${metricId} restored from archive`,
    )
  })

// ── Delete ──────────────────────────────────────────────────

const metricsDeleteCommand = new Command('delete')
  .argument('<metricId>', 'Metric ID')
  .description('Delete a metric (rejected if metric bindings reference it)')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (metricId: string, opts: { project?: string; force?: boolean }) => {
    const config = ensureLoggedIn()
    const shortId = resolveProjectShortId(opts)
    const api = new ApiClient(config)

    if (!opts.force) {
      if (!isInteractiveRun()) {
        failCommand(
          new CliError('cli_usage', `Deleting metric ${metricId} needs a confirmation this run cannot ask for.`, [
            `Pass -f to delete without asking: \`avsb metrics delete ${metricId} -f\``,
          ]),
        )
      }
      const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
        {
          type: 'confirm',
          name: 'proceed',
          message: `Delete metric ${metricId}? Metric bindings referencing it will block deletion.`,
          default: false,
        },
      ])
      if (!proceed) {
        logger.info('Delete aborted.')
        return
      }
    }

    const spinner = ora('Deleting metric...').start()

    try {
      await api.deleteMetric(shortId, metricId)
      spinner.succeed(`Metric deleted: ${metricId}`)
    } catch (err) {
      spinner.fail('Failed to delete metric')
      if (isConflictError(err)) {
        const refs = extractBindingsReferencing(err)
        if (refs.length > 0) logger.error(`Referenced by ${refs.join(', ')}.`)
        logger.info(`Tip: run \`avsb metrics archive ${metricId}\` instead to hide it without losing history.`)
      }
      failCommand(err)
    }
  })

// ── Parent command ──────────────────────────────────────────

export const metricsCommand = new Command('metrics')
  .description('Manage metric tracking definitions')
  .addCommand(metricsListCommand)
  .addCommand(metricsCreateCommand)
  .addCommand(metricsUpdateCommand)
  .addCommand(metricsArchiveCommand)
  .addCommand(metricsUnarchiveCommand)
  .addCommand(metricsDeleteCommand)
