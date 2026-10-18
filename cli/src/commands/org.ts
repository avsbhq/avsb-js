/**
 * `avsb org` — show, list, and switch the active organization.
 *
 * Personal access tokens are user-scoped, not organization-scoped: one token
 * usually reaches every organization the account belongs to. Switching
 * therefore records a choice in `~/.avsb/config.json` (and keeps a token per
 * organization, so logging in with a second account's token adds a login
 * rather than replacing one).
 */

import { Command } from 'commander'
import inquirer from 'inquirer'
import chalk from 'chalk'
import { ensureLoggedIn, getConfigPath, readConfig, writeConfig } from '../lib/config.js'
import {
  activateOrg,
  buildOrgCandidates,
  describeTokenSource,
  matchOrgCandidate,
  CONFIG_VERSION,
  type OrgCandidate,
} from '../lib/credentials.js'
import { TOKEN_ENV_VAR } from '../lib/env.js'
import { ApiClient } from '../lib/api.js'
import { CliError } from '../lib/cliError.js'
import { currentPromptContext, refusalWithoutPrompt } from '../lib/interactive.js'
import * as logger from '../lib/logger.js'
import { startSpinner } from '../lib/outputMode.js'
import {
  beginCommand,
  emitJsonResult,
  failCommand,
  withOutputOptions,
  type OutputOptions,
} from '../lib/output.js'
import type { AvsbConfig, AvsbSession } from '../types/config.js'

const SAVED_ONLY_NOTE = '(saved login)'

/** Config to render against: the saved file, or an empty stand-in for env-only runs. */
function configForSession(session: AvsbSession): AvsbConfig {
  const read = readConfig()
  if (read.status === 'ok') return read.config
  return {
    version: CONFIG_VERSION,
    activeOrgId: '',
    logins: [],
    apiBaseUrl: session.apiBaseUrl,
  }
}

/** The organizations a token reaches, as `41 (Acme Corp), 42 (Beta Inc)`. */
function describeCandidates(candidates: OrgCandidate[]): string {
  return candidates.map((c) => (c.shortId != null ? `${c.shortId} (${c.name})` : c.name)).join(', ')
}

/** Actionable message when `avsb org switch <org>` matches nothing. */
export function describeSwitchFailure(
  candidates: OrgCandidate[],
  needle: string,
): string {
  if (candidates.length === 0) {
    return `No organization matches "${needle}". This token cannot reach any organization.`
  }
  return `No organization matches "${needle}". Available: ${describeCandidates(candidates)}.`
}

export const orgCommand = withOutputOptions(
  new Command('org').description('Show, list, and switch the active organization'),
).action((opts: OutputOptions) => {
  beginCommand('org', opts)
  const session = ensureLoggedIn()

  if (
    emitJsonResult({
      orgId: session.orgId || null,
      orgName: session.orgName || null,
      apiBaseUrl: session.apiBaseUrl,
      tokenSource: session.tokenSource,
      configPath: getConfigPath(),
    })
  ) {
    return
  }

  logger.heading('Current organization')
  if (session.orgName) {
    logger.field('Name', session.orgName)
    logger.field('ID', session.orgId)
  } else {
    logger.field('Name', 'not saved on this machine')
  }
  logger.field('API URL', session.apiBaseUrl)
  logger.field('Token from', describeTokenSource(session, getConfigPath()))

  if (session.tokenSource === 'env') {
    logger.dim(
      `  ${TOKEN_ENV_VAR} is set, so commands use that token. Run \`avsb whoami\` to see which account and organization it reaches.`,
    )
  }
})

orgCommand.addCommand(
  withOutputOptions(
    new Command('list').description('List the organizations this token can reach'),
  ).action(async (_opts: OutputOptions, command: Command) => {
    // `org` declares --json and --quiet too, and commander hands a flag typed
    // after `list` to the parent, so `avsb org list --json` printed the table
    // (QA N4-8). The merged view sees the flag wherever it was typed.
    beginCommand('org list', command.optsWithGlobals<OutputOptions>())
    try {
      const session = ensureLoggedIn()
      const config = configForSession(session)
      const spinner = startSpinner('Fetching organizations...')

      const client = new ApiClient(session)
      const response = await client.listOrgs()
      spinner.stop()

      const candidates = buildOrgCandidates(config, response.data)

      if (emitJsonResult(candidates)) return

      if (candidates.length === 0) {
        logger.warn('No organizations found for this token.')
        return
      }

      printOrgTable(candidates)
    } catch (err) {
      failCommand(err)
    }
  }),
)

orgCommand
  .command('switch')
  .description('Choose which organization commands use')
  .argument('[org]', 'Organization short id, id, or name')
  .option('--no-input', 'Never prompt; fail if no organization is named')
  .action(async (orgArg: string | undefined, options: { input: boolean }) => {
    beginCommand('org switch', {})
    try {
      const session = ensureLoggedIn()
      const read = readConfig()

      if (read.status !== 'ok') {
        failCommand(
          new CliError(
            'cli_not_logged_in',
            `Nothing to switch: your choice is saved in ${getConfigPath()}.`,
            ['Run `avsb login` first.'],
          ),
        )
      }
      const config = read.config

      const spinner = startSpinner('Fetching organizations...')
      const client = new ApiClient(session)
      const response = await client.listOrgs()
      spinner.stop()

      const candidates = buildOrgCandidates(config, response.data)
      if (candidates.length === 0) {
        failCommand(
          new CliError('cli_not_found', 'This token cannot reach any organization.'),
        )
      }

      const target = orgArg
        ? matchOrgCandidate(candidates, orgArg)
        : await promptForOrg(candidates, options.input)

      if (!target) {
        failCommand(new CliError('cli_not_found', describeSwitchFailure(candidates, orgArg ?? '')))
      }

      if (target.active) {
        logger.info(`Already using ${target.name}.`)
        return
      }

      writeConfig(activateOrg(config, target, session.token))

      logger.success(`Switched to ${target.name}.`)
      if (session.tokenSource === 'env') {
        logger.warn(
          `${TOKEN_ENV_VAR} is set, so requests still use that token. Unset it to use the saved login for ${target.name}.`,
        )
      }
    } catch (err) {
      failCommand(err)
    }
  })

async function promptForOrg(
  candidates: OrgCandidate[],
  input: boolean,
): Promise<OrgCandidate | null> {
  // With --no-input, or with no terminal to ask in, the organization has to be
  // named; asking anyway ended in a raw Node warning (QA N4-15).
  const refusal = refusalWithoutPrompt(
    {
      code: 'cli_usage',
      message: 'Name an organization: `avsb org switch <short id | id | name>`.',
      hints: [`Available: ${describeCandidates(candidates)}.`],
    },
    currentPromptContext({ input }),
  )
  if (refusal) failCommand(refusal)

  const { chosen } = await inquirer.prompt<{ chosen: string }>([
    {
      type: 'list',
      name: 'chosen',
      message: 'Which organization should commands use?',
      choices: candidates.map((candidate) => ({
        name: candidate.shortId != null
          ? `${candidate.name} (${candidate.shortId})`
          : `${candidate.name} ${SAVED_ONLY_NOTE}`,
        value: candidate.id,
      })),
      default: candidates.find((candidate) => candidate.active)?.id,
    },
  ])

  return candidates.find((candidate) => candidate.id === chosen) ?? null
}

function printOrgTable(candidates: OrgCandidate[]): void {
  const idColumn = (candidate: OrgCandidate): string =>
    candidate.shortId != null ? String(candidate.shortId) : '-'
  const idWidth = Math.max(2, ...candidates.map((c) => idColumn(c).length))

  logger.heading('Organizations')
  logger.line()
  logger.line(`  ${chalk.dim('ID'.padEnd(idWidth))}  ${chalk.dim('Name')}`)
  logger.line(`  ${chalk.dim('─'.repeat(idWidth))}  ${chalk.dim('─'.repeat(30))}`)

  for (const candidate of candidates) {
    // Two columns wide either way, so rows line up under the header.
    const marker = candidate.active ? `${chalk.green('●')} ` : '  '
    const name = candidate.active ? chalk.bold(candidate.name) : candidate.name
    const note = candidate.shortId == null ? chalk.dim(`  ${SAVED_ONLY_NOTE}`) : ''
    logger.line(`${marker}${idColumn(candidate).padEnd(idWidth)}  ${name}${note}`)
  }

  logger.line()
  logger.dim('  ● = organization commands use now')
  if (candidates.some((candidate) => candidate.shortId == null)) {
    logger.dim(
      `  ${SAVED_ONLY_NOTE} = saved from another token; log in with that token to use it`,
    )
  }
  logger.dim('  Change it with `avsb org switch <short id | id | name>`')
}
