/**
 * `avsb login` — save a personal access token for this machine.
 *
 * Three ways in:
 *   interactive  `avsb login`                        prompts for the token
 *   piped        `echo "$TOKEN" | avsb login`         reads it from stdin
 *   headless     `avsb login --token <t> --no-input` no prompts at all
 *
 * A piped token is read straight from stdin rather than through the masked
 * prompt, which drew one redraw line per character into the log, and a run
 * with no terminal never asks the re-login question (QA N4-14, N4-15).
 *
 * CI usually needs neither: set `AVSB_TOKEN` and every command uses it without
 * a saved login (see `lib/env.ts` for the precedence rules).
 */

import { Command } from 'commander'
import inquirer from 'inquirer'
import ora from 'ora'
import { readConfig, writeConfig, getConfigPath } from '../lib/config.js'
import { upsertLogin } from '../lib/credentials.js'
import {
  DEFAULT_API_BASE_URL,
  TOKEN_ENV_VAR,
  readEnvApiUrl,
  readEnvToken,
  stripTrailingSlash,
} from '../lib/env.js'
import { ApiClient } from '../lib/api.js'
import { ApiRequestError } from '../lib/apiError.js'
import { CliError } from '../lib/cliError.js'
import * as logger from '../lib/logger.js'
import { canPrompt, currentPromptContext, readPipedStdin } from '../lib/interactive.js'
import { failCommand } from '../lib/output.js'
import { WHERE_TO_GET_A_TOKEN } from '../lib/tokenShape.js'
import type { ApiAuthVerifyResponse } from '../types/account.js'
import type { AvsbConfig } from '../types/config.js'

interface LoginOptions {
  /** Undefined unless `-u, --url` was passed. The fallback chain runs in the action. */
  url?: string
  token?: string
  /** False when `--no-input` was passed. Commander's convention for negated flags. */
  input: boolean
}

export const loginCommand = new Command('login')
  .description('Save a personal access token for this machine')
  .option(
    '-u, --url <url>',
    `API base URL for development use (defaults to AVSB_API_URL, then ${DEFAULT_API_BASE_URL})`,
  )
  .option(
    '--token <token>',
    'Personal access token, for scripts and CI instead of the prompt',
  )
  .option('--no-input', 'Never prompt; fail if something is missing')
  .action(async (options: LoginOptions) => {
    try {
      // Read the environment here, not at import time, so the variables are
      // resolved when the command actually runs (see lib/env.ts).
      const apiBaseUrl = stripTrailingSlash(
        options.url ?? readEnvApiUrl() ?? DEFAULT_API_BASE_URL,
      )
      const envToken = readEnvToken()
      const explicitToken = options.token?.trim()
      const existing = readConfig()
      const existingConfig: AvsbConfig | null =
        existing.status === 'ok' ? existing.config : null

      // An unreadable file is worth saying out loud: this command is about to
      // replace it, and the user should know why their old login stopped working.
      if (existing.status === 'unreadable') {
        logger.warn(
          `Replacing the saved login in ${getConfigPath()}: ${existing.detail}.`,
        )
      }

      // Interactive re-login confirmation, only when there is nothing explicit
      // to act on and a terminal to ask in. A piped token is explicit enough.
      const interactive = canPrompt(currentPromptContext({ input: options.input }))
      if (existingConfig && interactive && !explicitToken && !envToken) {
        const active = existingConfig.logins.find(
          (login) => login.orgId === existingConfig.activeOrgId,
        )
        logger.heading('Already logged in')
        logger.label('Organization', active?.orgName ?? '(none selected)')
        logger.label('API URL', existingConfig.apiBaseUrl)
        logger.label('Saved logins', String(existingConfig.logins.length))
        logger.line()

        const { reLogin } = await inquirer.prompt<{ reLogin: boolean }>([
          {
            type: 'confirm',
            name: 'reLogin',
            message: 'Add or replace a login with a different token?',
            default: false,
          },
        ])

        if (!reLogin) return
      }

      const token = await resolveToken({
        explicitToken,
        envToken,
        source: tokenSourceFor({
          explicitToken,
          envToken,
          input: options.input,
          isTty: process.stdin.isTTY === true,
        }),
      })

      const spinner = ora('Verifying token...').start()

      // Verify exactly the token and URL resolved above, ignoring the
      // environment so `--token` means what it says.
      const client = new ApiClient({ token, apiBaseUrl }, { useEnvOverrides: false })

      let verified: ApiAuthVerifyResponse
      try {
        verified = await client.verifyAuth()
      } catch (err) {
        // Pass the real failure through. A refused token, an unreachable host
        // and a DNS error are different problems, and calling all three a
        // credential-shape error would be untrue and would exit with the wrong
        // code. A genuine shape refusal is raised as `cli_credential_shape`
        // before the request is ever made, and the transport's own 401 advice
        // already names the credential; this only adds where to get one.
        // Only a 401 is the token's fault. A host that does not resolve or does
        // not answer used to read "Token rejected" too (QA N4-10).
        const rejected = err instanceof ApiRequestError && err.status === 401
        spinner.fail(rejected ? 'Token rejected' : 'Could not check the token')
        if (rejected) {
          logger.dim(`  ${WHERE_TO_GET_A_TOKEN}`)
        }
        failCommand(err)
      }

      spinner.succeed('Token verified')

      const config = upsertLogin(
        existingConfig,
        {
          orgId: verified.data.orgId,
          orgName: verified.data.orgName,
          token,
        },
        apiBaseUrl,
      )
      writeConfig(config)

      logger.line()
      logger.success(
        `Logged in to ${verified.data.orgName} as ${verified.data.email}`,
      )
      logger.dim(`  Token saved in plain text at ${getConfigPath()} (file mode 0600).`)

      if (config.logins.length > 1) {
        logger.dim(
          `  ${config.logins.length} logins saved. Switch with \`avsb org switch\`.`,
        )
      }

      if (envToken && explicitToken && envToken !== explicitToken) {
        logger.warn(
          `${TOKEN_ENV_VAR} is set, so commands will use that token instead of the one just saved. Unset it to use the saved login.`,
        )
      }
    } catch (err) {
      failCommand(err)
    }
  })

export type TokenSource = 'flag' | 'env' | 'prompt' | 'stdin' | 'refuse'

/**
 * Where the token comes from: `--token`, then `AVSB_TOKEN`, then the prompt in
 * a terminal or stdin when something is piped in. With `--no-input` and
 * neither flag nor variable, refuse instead of hanging. Pure, for the tests.
 */
export function tokenSourceFor(input: {
  explicitToken?: string
  envToken: string | null
  input: boolean
  isTty: boolean
}): TokenSource {
  if (input.explicitToken) return 'flag'
  if (input.envToken) return 'env'
  if (!input.input) return 'refuse'
  return input.isTty ? 'prompt' : 'stdin'
}

const NO_TOKEN_HINTS = [
  `Pass --token <token>, set ${TOKEN_ENV_VAR}, or pipe it in: echo "$TOKEN" | avsb login`,
]

async function resolveToken(input: {
  explicitToken?: string
  envToken: string | null
  source: TokenSource
}): Promise<string> {
  if (input.source === 'flag' && input.explicitToken) return input.explicitToken

  if (input.source === 'env' && input.envToken) {
    logger.info(`Using the token from ${TOKEN_ENV_VAR}.`)
    return input.envToken
  }

  if (input.source === 'refuse') {
    failCommand(
      new CliError(
        'cli_usage',
        `No token supplied. Pass --token <token> or set ${TOKEN_ENV_VAR} when using --no-input.`,
      ),
    )
  }

  if (input.source === 'stdin') {
    const piped = (await readPipedStdin()).trim()
    if (piped.length === 0) {
      failCommand(new CliError('cli_usage', 'No token supplied, and there is no terminal to ask in.', NO_TOKEN_HINTS))
    }
    return piped
  }

  const { token } = await inquirer.prompt<{ token: string }>([
    {
      type: 'password',
      name: 'token',
      message: 'Paste your personal access token:',
      mask: '*',
      validate: (value: string) =>
        value.trim().length > 0 || 'A personal access token is required',
    },
  ])

  return token.trim()
}
