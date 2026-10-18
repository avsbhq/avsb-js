import { Command } from 'commander'
import ora from 'ora'
import chalk from 'chalk'
import { ensureLoggedIn } from '../lib/config.js'
import { ApiClient } from '../lib/api.js'
import { parseExperimentInput } from '../lib/manifest.js'
import { scaffoldExperiment } from '../lib/scaffold.js'
import { CliError } from '../lib/cliError.js'
import { EXIT } from '../lib/exitCodes.js'
import * as logger from '../lib/logger.js'
import { failCommand } from '../lib/output.js'

export const cloneCommand = new Command('clone')
  .description('Clone an experiment to your local machine')
  .argument('<experiment>', 'Experiment URL, EXP-123, or numeric ID')
  .action(async (experimentInput: string) => {
    const config = ensureLoggedIn()

    let shortId: number
    try {
      shortId = parseExperimentInput(experimentInput)
    } catch {
      failCommand(
        new CliError(
          'cli_usage',
          'Invalid experiment identifier. Use a URL, EXP-123, or a numeric ID.',
        ),
      )
    }

    const api = new ApiClient(config)
    const spinner = ora('Fetching experiment...').start()

    let response
    try {
      response = await api.getExperiment(shortId)
      spinner.succeed('Experiment found')
    } catch (err) {
      spinner.fail('Failed to fetch experiment')
      failCommand(err)
    }

    const { experiment } = response.data

    logger.line()
    logger.heading(experiment.name)
    logger.label('ID', `EXP-${experiment.shortId}`)
    logger.label('Status', experiment.status)
    logger.label('Variations', String(experiment.variations.length))
    logger.line()

    // Read language settings from the platform (no prompt needed)
    const script = experiment.scriptLang === 'TYPESCRIPT' ? 'ts' : 'js'
    const style = experiment.styleLang === 'SCSS' ? 'scss' : 'css'

    const scaffoldSpinner = ora('Scaffolding experiment files...').start()

    let result
    try {
      result = scaffoldExperiment({
        data: response.data,
        script,
        style,
        apiBaseUrl: config.apiBaseUrl,
      })
      scaffoldSpinner.succeed('Files created')
    } catch (err) {
      scaffoldSpinner.fail('Scaffolding failed')
      const message = err instanceof Error ? err.message : 'Unknown error'
      if (message.includes('already exists')) {
        logger.error(`Directory already exists. Remove it first or choose a different location.`)
      } else {
        logger.error(message)
      }
      process.exit(EXIT.failure)
    }

    logger.line()
    logger.fileTree(result.files)
    logger.line()

    const dirName = result.dir.split('/').pop() ?? result.dir
    logger.success(`Experiment cloned to ${chalk.bold(dirName)}/`)
  })
