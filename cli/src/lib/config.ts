/**
 * Reading and writing the CLI's saved login file, plus the one helper every
 * command calls to get its credentials.
 *
 * Storage reality, documented as-is in the CLI docs: `~/.avsb/config.json`,
 * plain-text JSON, created with 0600 permissions. No OS keychain is involved
 * on any platform. Set `AVSB_TOKEN` to run without saving a token to disk.
 *
 * Shape and precedence rules live in `credentials.ts`; this file only touches
 * the filesystem and the process.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readEnvApiUrl, readEnvToken, TOKEN_ENV_VAR } from './env.js'
import { CliError } from './cliError.js'
import * as logger from './logger.js'
import { failCommand } from './output.js'
import {
  parseConfigDocument,
  resolveSession,
  type ConfigReadResult,
} from './credentials.js'
import type { AvsbConfig, AvsbSession } from '../types/config.js'

const CONFIG_DIR = path.join(os.homedir(), '.avsb')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

export function getConfigPath(): string {
  return CONFIG_FILE
}

/** Read and validate the config file. Never throws. */
export function readConfig(): ConfigReadResult {
  let raw: string
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf-8')
  } catch {
    return { status: 'missing' }
  }
  return parseConfigDocument(raw)
}

export function writeConfig(config: AvsbConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
}

export function clearConfig(): void {
  try {
    fs.unlinkSync(CONFIG_FILE)
  } catch {
    // Already gone
  }
}

/**
 * Credentials for the current command run, or a clear message and exit code 3
 * (the credential code, so a script can branch on it without reading English).
 *
 * Messages go to stderr; under `--json` the same failure is also printed on
 * stdout as the standard error envelope.
 */
export function ensureLoggedIn(): AvsbSession {
  const result = resolveSession(readConfig(), {
    token: readEnvToken(),
    apiBaseUrl: readEnvApiUrl(),
  })

  if (result.status === 'ok') {
    if (result.warning) logger.warn(result.warning)
    return result.session
  }

  if (result.status === 'unreadable') {
    failCommand(
      new CliError(
        'cli_not_logged_in',
        `Could not use the saved login in ${CONFIG_FILE}: ${result.detail}.`,
        ['Run `avsb login` to sign in again.'],
      ),
    )
  }

  failCommand(
    new CliError('cli_not_logged_in', 'Not logged in.', [
      'Run `avsb login`.',
      `In scripts and CI, set ${TOKEN_ENV_VAR} to a personal access token instead.`,
    ]),
  )
}
