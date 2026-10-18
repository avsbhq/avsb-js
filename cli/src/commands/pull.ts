import { Command } from 'commander'
import inquirer from 'inquirer'
import ora from 'ora'
import { ensureLoggedIn } from '../lib/config.js'
import { ApiClient } from '../lib/api.js'
import { readManifestOrExit } from '../lib/manifest.js'
import { diffLocalFiles, updateLocalFiles } from '../lib/scaffold.js'
import { EXIT } from '../lib/exitCodes.js'
import { refusalWithoutPrompt } from '../lib/interactive.js'
import * as logger from '../lib/logger.js'
import { failCommand } from '../lib/output.js'

export const pullCommand = new Command('pull')
  .description('Pull latest experiment data from the platform')
  .option('-f, --force', 'Skip local change check and pull without confirmation')
  .action(async (options: { force?: boolean }) => {
    try {
      const config = ensureLoggedIn()
      const { manifest, dir } = readManifestOrExit()

      let spinner = ora('Fetching latest experiment data...').start()

      const client = new ApiClient(config)
      const response = await client.getExperiment(manifest.experimentShortId)

      // Pre-pull local change detection
      if (!options.force) {
        const localChanges = diffLocalFiles(dir, manifest, response.data)

        if (localChanges.length > 0) {
          spinner.warn('Local files have unsaved changes')
          logger.line()

          logger.heading('Modified local files:')
          for (const file of localChanges) {
            logger.dim(`  ${file}`)
          }

          logger.line()
          const refusal = refusalWithoutPrompt({
            code: 'cli_conflict',
            message: 'Pulling would overwrite these local changes, and this run cannot ask first.',
            hints: [
              'Run `avsb pull --force` to overwrite them,',
              'or `avsb push` first to keep them on the platform.',
            ],
          })
          if (refusal) failCommand(refusal)
          const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
            {
              type: 'confirm',
              name: 'proceed',
              message: 'Pulling will overwrite these local changes. Continue?',
              default: false,
            },
          ])

          if (!proceed) {
            logger.info('Pull aborted. Push your local changes first with `avsb push`.')
            process.exit(EXIT.success)
          }

          spinner = ora('Applying changes...').start()
        }
      }

      const updatedFiles = updateLocalFiles(dir, manifest, response.data)

      spinner.succeed('Fetched latest data')
      logger.line()

      if (updatedFiles.length > 0) {
        logger.heading('Updated files:')
        for (const file of updatedFiles) {
          logger.dim(`  ${file}`)
        }
        logger.line()
        logger.success(`Pulled ${updatedFiles.length} updated file${updatedFiles.length === 1 ? '' : 's'}`)
      } else {
        logger.success('Already up to date')
      }
    } catch (err) {
      failCommand(err)
    }
  })
