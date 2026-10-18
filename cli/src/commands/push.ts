import { createHash } from 'node:crypto'
import { Command } from 'commander'
import inquirer from 'inquirer'
import ora from 'ora'
import { ensureLoggedIn } from '../lib/config.js'
import { ApiClient } from '../lib/api.js'
import { readManifestOrExit, writeManifest, computeSyncHashes } from '../lib/manifest.js'
import { CliError } from '../lib/cliError.js'
import { EXIT } from '../lib/exitCodes.js'
import { isInteractiveRun } from '../lib/interactive.js'
import * as logger from '../lib/logger.js'
import { failCommand } from '../lib/output.js'
import type { ApiExperimentResponse, AvsbManifest, SyncedHashes } from '../types/experiment.js'
import { buildPushPayload, labelForPushPath, publishPromptFor } from './push.payload.js'

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function detectRemoteChanges(
  remoteExp: ApiExperimentResponse['data']['experiment'],
  syncedHashes: SyncedHashes
): string[] {
  const changed: string[] = []

  if (sha256(remoteExp.triggersJs) !== syncedHashes.triggersJs) {
    changed.push('triggers')
  }

  for (const v of remoteExp.variations) {
    const stored = syncedHashes.variations[v.id]
    if (!stored) {
      changed.push(`${v.name} (new on remote)`)
      continue
    }
    if (sha256(v.controlJs) !== stored.controlJs) {
      changed.push(`${v.name}/script`)
    }
    if (sha256(v.controlCss) !== stored.controlCss) {
      changed.push(`${v.name}/style`)
    }
  }

  return changed
}

interface PushOptions {
  force?: boolean
  /** true for --publish, false for --no-publish, undefined to ask. */
  publish?: boolean
}

/** Ask before overwriting remote edits, or refuse with the flags to pass when this run cannot ask. */
async function confirmOverwrite(): Promise<boolean> {
  if (!isInteractiveRun()) {
    failCommand(
      new CliError(
        'cli_conflict',
        'The platform copy changed since your last pull, and this run cannot ask before overwriting it.',
        [
          'Run `avsb pull` to fetch the remote changes first (it overwrites your local files),',
          'or `avsb push --force` to overwrite the remote changes.',
        ],
      ),
    )
  }
  const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
    { type: 'confirm', name: 'proceed', message: 'Pushing will overwrite remote changes. Continue?', default: false },
  ])
  return proceed
}

/**
 * `--publish` and `--no-publish` answer the question. Without either, ask; a
 * run that cannot ask leaves the changes pending, which is the safe answer.
 */
async function shouldPublish(options: PushOptions, status: string | undefined): Promise<boolean> {
  if (options.publish !== undefined) return options.publish
  if (!isInteractiveRun()) return false
  const { publish } = await inquirer.prompt<{ publish: boolean }>([
    { type: 'confirm', name: 'publish', message: publishPromptFor(status), default: false },
  ])
  return publish
}

export const pushCommand = new Command('push')
  .description('Compile and push local changes to the platform')
  .option('-f, --force', 'Skip conflict check and push without confirmation')
  .option('--publish', 'Publish the changes right away when the experiment is running or paused')
  .option('--no-publish', 'Leave the changes pending without asking')
  .action(async (options: PushOptions) => {
    let manifest: AvsbManifest | null = null
    try {
      const config = ensureLoggedIn()
      const read = readManifestOrExit()
      manifest = read.manifest
      const { dir } = read

      let spinner = ora('Compiling experiment...').start()

      // Compile every file before any request: a TypeScript or SCSS error stops
      // here with its file, line and column, and nothing is uploaded.
      const built = await buildPushPayload(dir, manifest)
      if (!built.ok) {
        spinner.fail(built.summary)
        for (const e of built.errors) {
          logger.error(`  ${e.line > 0 ? `${e.file}:${e.line}:${e.column}` : e.file}: ${e.message}`)
        }
        process.exit(EXIT.failure)
      }

      const client = new ApiClient(config)

      // Pre-push conflict detection
      if (!options.force && manifest.syncedHashes) {
        spinner.text = 'Checking for remote changes...'
        const remote = await client.getExperiment(manifest.experimentShortId)
        const remoteChanges = detectRemoteChanges(remote.data.experiment, manifest.syncedHashes)

        if (remoteChanges.length > 0) {
          spinner.warn('Remote has changes you haven\'t pulled')
          logger.line()
          logger.heading('Files changed on remote:')
          for (const file of remoteChanges) logger.dim(`  ${file}`)
          logger.line()

          if (!(await confirmOverwrite())) {
            logger.info('Push aborted. Run `avsb pull` to fetch remote changes first.')
            logger.warn('Note: pulling will overwrite your local files.')
            process.exit(EXIT.success)
          }
          spinner = ora('Pushing to platform...').start()
        } else {
          spinner.text = 'Pushing to platform...'
        }
      } else {
        spinner.text = 'Pushing to platform...'
      }

      let response: Awaited<ReturnType<ApiClient['pushExperiment']>>
      try {
        response = await client.pushExperiment(manifest.experimentShortId, built.payload)
      } catch (err) {
        spinner.fail('Push refused')
        throw err
      }

      // Update synced hashes with raw source (what's actually stored on platform)
      manifest.syncedHashes = computeSyncHashes(built.sources.triggersJs, built.sources.variations)
      writeManifest(dir, manifest)

      spinner.succeed('Pushed successfully')
      logger.line()

      if (response.data.hasPendingChanges) {
        if (await shouldPublish(options, response.data.status)) {
          const publishSpinner = ora('Publishing changes...').start()
          const published = await client.publishChanges(manifest.experimentShortId)
          publishSpinner.succeed('Changes published')
          if (published.data.warning) logger.warn(published.data.warning.message)
        } else {
          logger.info('Changes saved as pending. Publish them with `avsb push --publish`, or from the dashboard.')
        }
      }

      logger.line()
      logger.success('Push complete')
    } catch (err) {
      // A refusal that names a request-body path (`variations.0.controlJs`)
      // is printed with the clone folder's own file name instead.
      const current = manifest
      failCommand(err, current ? { labelForPath: (bodyPath) => labelForPushPath(current, bodyPath) } : {})
    }
  })
