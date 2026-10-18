/**
 * `avsb experiments list` — what is running in a project, without opening a
 * browser.
 *
 * Reads the public API (`/api/v1/projects/{projectId}/experiments`) with the
 * same personal access token as everything else. Editing an experiment's code
 * still belongs to `avsb clone` / `avsb push`; this is the answer to "what is
 * live right now, and what is its id?".
 */

import { Command } from 'commander'
import { ensureLoggedIn } from '../lib/config.js'
import { FlagsApiClient } from '../lib/flagsApi.js'
import * as logger from '../lib/logger.js'
import { startSpinner } from '../lib/outputMode.js'
import { beginCommand, emitJsonResult, failCommand, withOutputOptions } from '../lib/output.js'
import { parseLimitOption } from '../lib/listOptions.js'
import { resolveProjectRefOrExit } from '../lib/projectRef.js'
import type { CliPublicExperiment } from '../types/experiment.js'

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return value.slice(0, max - 1) + '…'
}

/** The header plus one padded line per experiment. */
export function formatExperimentTable(experiments: CliPublicExperiment[]): string[] {
  const rows = experiments.map((experiment) => ({
    id: `EXP-${experiment.shortId}`,
    status: experiment.status,
    name: truncate(experiment.name, 44),
    updated: experiment.updatedAt.slice(0, 10),
  }))

  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
  }

  const header = [
    'ID'.padEnd(widths.id),
    'Status'.padEnd(widths.status),
    'Name'.padEnd(widths.name),
    'Updated',
  ].join('  ')

  const lines = rows.map((row) =>
    [
      row.id.padEnd(widths.id),
      row.status.padEnd(widths.status),
      row.name.padEnd(widths.name),
      row.updated,
    ].join('  '),
  )

  return [header, ...lines]
}

const experimentsListCommand = withOutputOptions(
  new Command('list')
    .description('List experiments in a project')
    .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
    .option('--limit <n>', 'Rows per page (1-100, default 20)')
    .option('--cursor <cursor>', 'Page cursor from a previous run'),
).action(
  async (opts: {
    project?: string
    limit?: string
    cursor?: string
    json?: boolean
    quiet?: boolean
  }) => {
    beginCommand('experiments list', opts)
    const session = ensureLoggedIn()
    const project = resolveProjectRefOrExit(opts)
    const limit = parseLimitOption(opts.limit)
    const api = new FlagsApiClient(session)
    const spinner = startSpinner('Fetching experiments...')

    try {
      const response = await api.listExperiments(project.shortId, {
        limit,
        cursor: opts.cursor,
      })
      spinner.succeed(`Fetched experiments for PRJ-${project.shortId}`)

      if (
        emitJsonResult(response.data, {
          page: response.page,
        })
      ) {
        return
      }

      if (response.data.length === 0) {
        logger.line()
        logger.info('No experiments yet. Create one in the dashboard, then `avsb clone EXP-<id>`.')
        return
      }

      logger.line()
      const [header, ...rows] = formatExperimentTable(response.data)
      logger.heading(header)
      for (const row of rows) logger.line(row)
      logger.line()
      logger.dim('  Edit one locally with `avsb clone EXP-<id>`')
      if (response.page.hasMore && response.page.nextCursor) {
        logger.dim(`  More experiments: rerun with --cursor ${response.page.nextCursor}`)
      }
    } catch (err) {
      spinner.fail('Failed to fetch experiments')
      failCommand(err)
    }
  },
)

export const experimentsCommand = new Command('experiments')
  .description('List experiments in a project')
  .addCommand(experimentsListCommand)
