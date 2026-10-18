/**
 * `avsb status` — what the local manifest says about this experiment.
 *
 * Manifest facts only: there is no comparison with the platform here, so the
 * output never claims to know whether local files are ahead of or behind it.
 * `avsb push` is what detects remote changes (it hashes the remote copy first).
 */

import { Command } from 'commander'
import chalk from 'chalk'
import { CliError } from '../lib/cliError.js'
import { findManifest } from '../lib/manifest.js'
import * as logger from '../lib/logger.js'
import {
  beginCommand,
  emitJsonResult,
  failCommand,
  withOutputOptions,
  type OutputOptions,
} from '../lib/output.js'
import type { AvsbManifest } from '../types/experiment.js'

function formatRelativeTime(isoDate: string): string {
  const now = Date.now()
  const then = new Date(isoDate).getTime()
  const diffMs = now - then

  const seconds = Math.floor(diffMs / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function formatStatus(status: string): string {
  switch (status) {
    case 'RUNNING':
      return chalk.green(status)
    case 'PAUSED':
      return chalk.yellow(status)
    case 'COMPLETED':
      return chalk.blue(status)
    case 'SCHEDULED':
      return chalk.cyan(status)
    case 'DRAFT':
    default:
      return chalk.dim(status)
  }
}

export interface StatusRow {
  label: string
  value: string
}

/**
 * Every row `avsb status` prints, in order. Pure so the documented field list
 * and the printed field list cannot drift apart.
 */
export function buildStatusRows(manifest: AvsbManifest): StatusRow[] {
  return [
    { label: 'Experiment', value: `EXP-${manifest.experimentShortId}` },
    { label: 'Status', value: formatStatus(manifest.status) },
    { label: 'Variations', value: String(manifest.variations.length) },
    { label: 'Script', value: manifest.languages.script.toUpperCase() },
    { label: 'Style', value: manifest.languages.style.toUpperCase() },
    { label: 'Last synced', value: formatRelativeTime(manifest.lastSyncedAt) },
    { label: 'Platform', value: manifest.platformUrl },
  ]
}

export const statusCommand = withOutputOptions(
  new Command('status').description('Show what the local manifest says about this experiment'),
).action((opts: OutputOptions) => {
  beginCommand('status', opts)

  const manifest = findManifest()

  if (!manifest) {
    failCommand(
      new CliError('cli_no_manifest', 'Not inside an experiment directory.', [
        'Run `avsb clone <experiment>` first, or change into a folder it created.',
      ]),
    )
  }

  // The JSON view is the manifest's own field names, not the printed labels: a
  // script wants `experimentShortId`, not "Experiment: EXP-42".
  if (
    emitJsonResult({
      experimentId: manifest.experimentId,
      experimentShortId: manifest.experimentShortId,
      experimentName: manifest.experimentName,
      projectId: manifest.projectId,
      projectShortId: manifest.projectShortId,
      status: manifest.status,
      variationCount: manifest.variations.length,
      languages: manifest.languages,
      lastSyncedAt: manifest.lastSyncedAt,
      platformUrl: manifest.platformUrl,
    })
  ) {
    return
  }

  logger.line()
  logger.heading(manifest.experimentName)
  logger.line()
  for (const row of buildStatusRows(manifest)) {
    logger.field(row.label, row.value)
  }
  logger.line()
})
