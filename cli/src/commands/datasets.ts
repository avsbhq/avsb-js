/**
 * `avsb datasets` command group — manage server-side datasets.
 *
 * Calls the personal-token CLI proxy routes
 * `/api/cli/projects/{shortId}/datasets/...` (spec
 * _specs/ecommerce-suite-spec.md §2.5) with the CLI's Bearer token,
 * addressing the project by short id (PRJ-42) exactly like the metrics
 * commands. Logic helpers live in `datasets.helpers.ts` to keep this file
 * focused on commander wiring.
 */

import fs from 'node:fs'
import { Command } from 'commander'
import inquirer from 'inquirer'
import ora from 'ora'
import { ensureLoggedIn } from '../lib/config.js'
import { ApiClient } from '../lib/api.js'
import { CliError } from '../lib/cliError.js'
import { refusalWithoutPrompt } from '../lib/interactive.js'
import * as logger from '../lib/logger.js'
import { startSpinner } from '../lib/outputMode.js'
import {
  beginCommand,
  emitJsonResult,
  failCommand,
  withOutputOptions,
} from '../lib/output.js'
import { resolveProjectShortId } from './metrics.helpers.js'
import {
  parseVersionArg,
  validateNdjsonPath,
  resolveDatasetBySlug,
  findVersionByShortId,
  findRollbackTarget,
  runPushFlow,
  describeVersionError,
  versionLabel,
  formatDatasetTable,
} from './datasets.helpers.js'

const DEFAULT_COMMIT_TIMEOUT_SECONDS = 300

function fail(spinner: { fail: (text?: string) => void }, message: string, err: unknown): never {
  spinner.fail(message)
  failCommand(err)
}

// ── List ────────────────────────────────────────────────────

const datasetsListCommand = withOutputOptions(
  new Command('list')
    .description('List datasets for a project')
    .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest'),
).action(async (opts: { project?: string; json?: boolean; quiet?: boolean }) => {
    beginCommand('datasets list', opts)
    const config = ensureLoggedIn()
    const projectShortId = resolveProjectShortId(opts)
    const api = new ApiClient(config)
    const spinner = startSpinner('Fetching datasets...')

    try {
      const response = await api.listDatasets(projectShortId)
      const { datasets } = response.data
      spinner.succeed(`Fetched datasets for PRJ-${projectShortId}`)

      if (emitJsonResult(response.data)) return

      if (datasets.length === 0) {
        logger.line()
        logger.info('No datasets yet. Create one in the dashboard, then `avsb datasets push <slug> <file>`.')
        return
      }

      logger.line()
      const [header, ...lines] = formatDatasetTable(datasets)
      logger.heading(header)
      for (const line of lines) logger.line(line)
      logger.line()
    } catch (err) {
      fail(spinner, 'Failed to fetch datasets', err)
    }
  })

// ── Push ────────────────────────────────────────────────────

const datasetsPushCommand = new Command('push')
  .argument('<slug>', 'Dataset slug')
  .argument('<file>', 'NDJSON file to upload (.ndjson)')
  .description('Upload an NDJSON file as a new dataset version (create → upload → commit)')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .option('--label <label>', 'Free-form version label (e.g. "2026-06-12 nightly")')
  .option('--activate', 'Activate the version once committed')
  .option(
    '--timeout <seconds>',
    `Seconds to wait for the commit to finish (default ${DEFAULT_COMMIT_TIMEOUT_SECONDS})`,
  )
  .action(
    async (
      slug: string,
      file: string,
      opts: { project?: string; label?: string; activate?: boolean; timeout?: string },
    ) => {
      const config = ensureLoggedIn()
      const projectShortId = resolveProjectShortId(opts)

      let resolvedPath: string
      try {
        resolvedPath = validateNdjsonPath(file)
      } catch (err) {
        failCommand(
          new CliError('cli_usage', err instanceof Error ? err.message : 'Invalid file'),
        )
      }

      const timeoutSeconds = opts.timeout ? Number(opts.timeout) : DEFAULT_COMMIT_TIMEOUT_SECONDS
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
        failCommand(
          new CliError('cli_usage', 'Invalid --timeout value. Pass a positive number of seconds.'),
        )
      }

      const api = new ApiClient(config)
      const spinner = ora('Pushing dataset version...').start()

      try {
        const result = await runPushFlow(api, projectShortId, {
          slug,
          fileBody: fs.readFileSync(resolvedPath),
          label: opts.label,
          activate: opts.activate,
          poll: { timeoutMs: timeoutSeconds * 1000 },
          onStep: (step) => {
            spinner.text = `${step}...`
          },
        })

        spinner.succeed(
          `Committed ${versionLabel(result.version)} of "${slug}" (${result.version.rowCount} rows)` +
            (result.activated ? ' (activated)' : ''),
        )
        if (!result.activated) {
          logger.info(
            `Run \`avsb datasets activate ${slug} ${versionLabel(result.version)}\` to make it live.`,
          )
        }
      } catch (err) {
        fail(spinner, 'Failed to push dataset version', err)
      }
    },
  )

// ── Activate ────────────────────────────────────────────────

const datasetsActivateCommand = new Command('activate')
  .argument('<slug>', 'Dataset slug')
  .argument('<version>', 'Version short id (e.g. 12 or v12)')
  .description('Activate a committed dataset version')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .action(async (slug: string, versionArg: string, opts: { project?: string }) => {
    const config = ensureLoggedIn()
    const projectShortId = resolveProjectShortId(opts)

    let versionShortId: number
    try {
      versionShortId = parseVersionArg(versionArg)
    } catch (err) {
      failCommand(
        new CliError('cli_usage', err instanceof Error ? err.message : 'Invalid version'),
      )
    }

    const api = new ApiClient(config)
    const spinner = ora('Activating version...').start()

    try {
      const dataset = await resolveDatasetBySlug(api, projectShortId, slug)
      const detail = await api.getDataset(projectShortId, dataset.id)
      const version = findVersionByShortId(detail.data.versions, versionShortId)

      if (!version) {
        throw new Error(`No version v${versionShortId} on dataset "${slug}".`)
      }
      if (version.status === 'ACTIVE') {
        spinner.succeed(`v${versionShortId} of "${slug}" is already live.`)
        return
      }
      if (version.status === 'ARCHIVED') {
        throw new Error(
          `v${versionShortId} has been archived and can no longer be re-activated. Push a new version instead.`,
        )
      }
      if (version.status !== 'COMMITTED') {
        throw new Error(
          `v${versionShortId} is ${version.status}. Only committed versions can be activated.` +
            (version.status === 'FAILED'
              ? ` Commit error: ${describeVersionError(version.error)}`
              : ''),
        )
      }

      await api.activateDatasetVersion(projectShortId, dataset.id, version.id)
      spinner.succeed(`Activated v${versionShortId} of "${slug}": now serving live.`)
    } catch (err) {
      fail(spinner, 'Failed to activate version', err)
    }
  })

// ── Rollback ────────────────────────────────────────────────

const datasetsRollbackCommand = new Command('rollback')
  .argument('<slug>', 'Dataset slug')
  .description('Re-activate the previous live version (most recent committed version older than the current live one)')
  .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
  .option('-f, --force', 'Skip confirmation prompt')
  .action(async (slug: string, opts: { project?: string; force?: boolean }) => {
    const config = ensureLoggedIn()
    const projectShortId = resolveProjectShortId(opts)
    const api = new ApiClient(config)
    const spinner = ora('Resolving rollback target...').start()

    let datasetId: string
    let targetId: string
    let summary: string

    try {
      const dataset = await resolveDatasetBySlug(api, projectShortId, slug)
      const detail = await api.getDataset(projectShortId, dataset.id)
      const rollback = findRollbackTarget(detail.data.versions, dataset.liveVersionId)

      if (!rollback.ok) {
        if (rollback.reason === 'no-live') {
          throw new Error(`Dataset "${slug}" has no live version to roll back from.`)
        }
        if (rollback.reason === 'archived-only') {
          throw new Error(
            `Previous versions of "${slug}" have been archived and can no longer be re-activated. Push a new version instead.`,
          )
        }
        throw new Error(
          `No committed version older than the current live one (${versionLabel(rollback.live)}). Nothing to roll back to.`,
        )
      }

      datasetId = dataset.id
      targetId = rollback.target.id
      summary = `${versionLabel(rollback.live)} → ${versionLabel(rollback.target)}`
      spinner.succeed(`Rollback target: ${summary}`)
    } catch (err) {
      fail(spinner, 'Failed to resolve rollback target', err)
    }

    if (!opts.force) {
      const refusal = refusalWithoutPrompt({
        code: 'cli_usage',
        message: `Rolling back "${slug}" (${summary}) needs a confirmation this run cannot ask for.`,
        hints: [`Pass -f to roll back without asking: \`avsb datasets rollback ${slug} -f\``],
      })
      if (refusal) failCommand(refusal)
      const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
        {
          type: 'confirm',
          name: 'proceed',
          message: `Roll back "${slug}" (${summary})? Live traffic switches within ~60s.`,
          default: false,
        },
      ])
      if (!proceed) {
        logger.info('Rollback aborted.')
        return
      }
    }

    const activateSpinner = ora('Rolling back...').start()
    try {
      await api.activateDatasetVersion(projectShortId, datasetId, targetId)
      activateSpinner.succeed(`Rolled back "${slug}": ${summary}`)
    } catch (err) {
      fail(activateSpinner, 'Failed to roll back', err)
    }
  })

// ── Parent command ──────────────────────────────────────────

export const datasetsCommand = new Command('datasets')
  .description('Manage server-side datasets (lists, tables, feeds)')
  .addCommand(datasetsListCommand)
  .addCommand(datasetsPushCommand)
  .addCommand(datasetsActivateCommand)
  .addCommand(datasetsRollbackCommand)
