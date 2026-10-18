/**
 * `avsb whoami` — ask the platform who the current token belongs to.
 *
 * Everything printed here except the last two rows comes from
 * `/api/cli/auth/verify`, so it answers the question a saved config file
 * cannot: which account and organization does this token actually reach?
 */

import { Command } from 'commander'
import { ensureLoggedIn, getConfigPath } from '../lib/config.js'
import { describeTokenSource } from '../lib/credentials.js'
import { ApiClient } from '../lib/api.js'
import * as logger from '../lib/logger.js'
import { startSpinner } from '../lib/outputMode.js'
import {
  beginCommand,
  emitJsonResult,
  failCommand,
  withOutputOptions,
  type OutputOptions,
} from '../lib/output.js'
import type { ApiAuthVerifyResponse } from '../types/account.js'
import type { AvsbSession } from '../types/config.js'

export interface WhoamiRow {
  label: string
  value: string
}

/**
 * The role as a name. The platform used to send the whole role record, which
 * printed as `Role: [object Object]` (QA N4-13); it now sends the name, and an
 * older platform's record is read for its `name` rather than stringified.
 */
export function roleName(role: unknown): string {
  if (typeof role === 'string') return role
  if (typeof role === 'object' && role !== null && 'name' in role && typeof role.name === 'string') {
    return role.name
  }
  return 'unknown'
}

/**
 * Build the printed rows. Kept pure so the output contract is testable and so
 * every row can be traced to something real: the verify response or the local
 * session.
 */
export function buildWhoamiRows(
  verified: ApiAuthVerifyResponse['data'],
  session: AvsbSession,
  configPath: string,
): WhoamiRow[] {
  return [
    { label: 'Email', value: verified.email },
    { label: 'Organization', value: verified.orgName },
    { label: 'Org ID', value: verified.orgId },
    { label: 'Role', value: roleName(verified.role) },
    { label: 'API URL', value: session.apiBaseUrl },
    { label: 'Token from', value: describeTokenSource(session, configPath) },
  ]
}

export const whoamiCommand = withOutputOptions(
  new Command('whoami').description(
    'Show the account and organization the current token belongs to',
  ),
).action(async (opts: OutputOptions) => {
  beginCommand('whoami', opts)

  const session = ensureLoggedIn()
  const spinner = startSpinner('Checking token...')

  let verified: ApiAuthVerifyResponse
  try {
    const client = new ApiClient(session)
    // When a login is saved, ask about that organization so the role shown is
    // the role there. With only AVSB_TOKEN set there is no active
    // organization, so the platform answers with the account's first one.
    verified = await client.verifyAuth(session.orgId || undefined)
    spinner.stop()
  } catch (err) {
    spinner.fail('Could not verify the current token')
    failCommand(err)
  }

  if (
    emitJsonResult({
      email: verified.data.email,
      orgId: verified.data.orgId,
      orgName: verified.data.orgName,
      role: roleName(verified.data.role),
      apiBaseUrl: session.apiBaseUrl,
      tokenSource: session.tokenSource,
      configPath: getConfigPath(),
    })
  ) {
    return
  }

  logger.line()
  logger.heading('Signed in')
  for (const row of buildWhoamiRows(verified.data, session, getConfigPath())) {
    logger.field(row.label, row.value)
  }
  logger.line()
})
