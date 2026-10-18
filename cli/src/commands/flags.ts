/**
 * `avsb flags` — list, read, create, rename and toggle feature flags.
 *
 * These call the PUBLIC API (`/api/v1/projects/{projectId}/flags/**`), because
 * that is where the flag lifecycle lives. The same personal access token works
 * there, with the permissions of your role in the organization.
 *
 * Three things worth knowing:
 *   - A flag can be named by key, short id, or id. The API path accepts only the
 *     last two, so a key is resolved to an id first (see `flags.resolve.ts`) and
 *     the match is printed.
 *   - `toggle` uses the environment run/pause endpoints, which the platform
 *     makes idempotent on purpose: pausing an already-paused environment
 *     succeeds and reports `changed: false`, so an incident script can fire it
 *     blind.
 *   - `update` reads the flag first and sends the ETag back on the
 *     conditional-write header (`X-Avsb-If-Match`, see `lib/flagsApi.ts` for why
 *     it is not plain `If-Match`), so a change someone else made in between is
 *     refused (412) instead of being silently overwritten. `--force` opts out of
 *     that check.
 *
 * `--json` prints the platform's own body untouched; the normalization here is
 * for the human view only.
 */

import { Command } from 'commander'
import { ensureLoggedIn } from '../lib/config.js'
import { FlagsApiClient } from '../lib/flagsApi.js'
import { CliError } from '../lib/cliError.js'
import * as logger from '../lib/logger.js'
import { startSpinner } from '../lib/outputMode.js'
import { beginCommand, emitJsonResult, failCommand, withOutputOptions } from '../lib/output.js'
import { parseLimitOption } from '../lib/listOptions.js'
import { resolveProjectRefOrExit } from '../lib/projectRef.js'
import {
  buildCreateFlagBody,
  describeTransition,
  flagIdLabel,
  formatFlagTable,
  normalizeFlag,
  selectEnvConfig,
  type CreateFlagOptions,
} from './flags.helpers.js'
import { describeFlagResolution, withResolvedFlagRef } from './flags.resolve.js'
import type { CliFlag, CreateFlagBody, UpdateFlagBody } from '../types/flag.js'

interface SharedOptions {
  project?: string
  json?: boolean
  quiet?: boolean
}

/** Every subcommand takes the same project flag. */
function withProjectOption(cmd: Command): Command {
  return cmd.option(
    '--project <project>',
    'Project ID (PRJ-42 or numeric); defaults to local manifest',
  )
}

// ── List ────────────────────────────────────────────────────

const flagsListCommand = withOutputOptions(
  withProjectOption(
    new Command('list')
      .description('List feature flags in a project')
      .option('--limit <n>', 'Rows per page (1-100, default 20)')
      .option('--cursor <cursor>', 'Page cursor from a previous run'),
  ),
).action(async (opts: SharedOptions & { limit?: string; cursor?: string }) => {
  beginCommand('flags list', opts)
  const session = ensureLoggedIn()
  const project = resolveProjectRefOrExit(opts)
  const limit = parseLimitOption(opts.limit)
  const api = new FlagsApiClient(session)
  const spinner = startSpinner('Fetching flags...')

  try {
    const response = await api.listFlags(project.shortId, { limit, cursor: opts.cursor })
    spinner.succeed(`Fetched flags for PRJ-${project.shortId}`)

    // `data` is the platform's own list body; the cursor block rides in `meta`,
    // the same way every other list command reports its page.
    if (emitJsonResult(response.data, { page: response.page })) return

    const flags = response.data.map(normalizeFlag)

    if (flags.length === 0) {
      logger.line()
      logger.info('No flags yet. Create one with `avsb flags create my_flag`.')
      return
    }

    logger.line()
    const [header, ...rows] = formatFlagTable(flags)
    logger.heading(header)
    for (const row of rows) logger.line(row)
    logger.line()
    if (response.page.hasMore && response.page.nextCursor) {
      logger.dim(`  More flags: rerun with --cursor ${response.page.nextCursor}`)
    }
  } catch (err) {
    spinner.fail('Failed to fetch flags')
    failCommand(err)
  }
})

// ── Get ─────────────────────────────────────────────────────

const flagsGetCommand = withOutputOptions(
  withProjectOption(
    new Command('get')
      .argument('<flag>', 'Flag key, numeric short id, or id')
      .description('Show one flag, with its variations and environments'),
  ),
).action(async (flagRef: string, opts: SharedOptions) => {
  beginCommand('flags get', opts)
  const session = ensureLoggedIn()
  const project = resolveProjectRefOrExit(opts)
  const api = new FlagsApiClient(session)
  const spinner = startSpinner('Fetching flag...')

  try {
    const { result, resolution } = await withResolvedFlagRef(
      api,
      project.shortId,
      flagRef,
      (target) => api.getFlag(project.shortId, target.ref),
    )
    spinner.stop()

    // The ETag rides in `meta`, not in `data`: `data` stays exactly what the API
    // returned, and a script that wants a safe update has the value to pass to
    // `--if-match`.
    if (emitJsonResult(result.body.data, { etag: result.etag ?? undefined })) return

    const note = describeFlagResolution(flagRef, resolution)
    if (note) logger.dim(note)
    printFlag(normalizeFlag(result.body.data))
    if (result.etag) logger.dim(`  Version: ${result.etag}`)
  } catch (err) {
    spinner.fail('Failed to fetch flag')
    failCommand(err)
  }
})

function printFlag(flag: CliFlag): void {
  logger.line()
  logger.heading(`${flag.name} (${flag.key})`)
  logger.label('ID', flagIdLabel(flag))
  logger.label('Type', flag.type)
  logger.label('Status', flag.status)
  if (flag.description) logger.label('Description', flag.description)
  if (flag.stale) logger.label('Stale', 'yes, no evaluations recently')

  if (flag.variations.length > 0) {
    logger.line()
    logger.heading('Variations')
    for (const variation of flag.variations) {
      logger.label(variation.key, variation.value)
    }
  }

  if (flag.envConfigs.length > 0) {
    logger.line()
    logger.heading('Environments')
    for (const env of flag.envConfigs) {
      const pending = env.hasPendingChanges ? ', unpublished changes' : ''
      logger.label(
        env.environmentKey || env.environmentId,
        `${env.enabled ? 'serving' : 'paused'}${pending}`,
      )
    }
  } else if (flag.hasEnvironmentData) {
    logger.line()
    logger.dim('  No environments yet. Add one in the dashboard before this flag can serve.')
  }
  logger.line()
}

// ── Create ──────────────────────────────────────────────────

/** Input parsing lives in the helpers; this turns a refusal into the standard exit. */
function buildBodyOrExit(opts: CreateFlagOptions): CreateFlagBody {
  try {
    return buildCreateFlagBody(opts)
  } catch (err) {
    failCommand(err)
  }
}

const flagsCreateCommand = withOutputOptions(
  withProjectOption(
    new Command('create')
      .argument('<key>', 'Flag key: lowercase letters, numbers and underscores')
      .description('Create a feature flag')
      .option('--name <name>', 'Display name (defaults to the key)')
      .option('--description <text>', 'Optional description')
      .option('--type <type>', 'BOOLEAN | STRING | NUMBER | JSON', 'BOOLEAN')
      .option(
        '--variation <key=value>',
        'Repeatable variation. Boolean flags default to on=true and off=false',
        (value: string, previous: string[] = []) => previous.concat(value),
        [] as string[],
      )
      .option('--default <variationKey>', 'Variation served when no rule matches'),
  ),
).action(async (key: string, opts: SharedOptions & CreateFlagOptions) => {
  beginCommand('flags create', opts)
  const session = ensureLoggedIn()
  const project = resolveProjectRefOrExit(opts)
  const body = buildBodyOrExit({ ...opts, key })

  const api = new FlagsApiClient(session)
  const spinner = startSpinner('Creating flag...')

  try {
    const response = await api.createFlag(project.shortId, body)
    const flag = normalizeFlag(response.data)
    spinner.succeed(`Flag created: ${flag.key} (${flagIdLabel(flag)})`)

    if (emitJsonResult(response.data)) return

    printFlag(flag)
    logger.dim('  It serves nothing until a rule is added and the environment is running.')
  } catch (err) {
    spinner.fail('Failed to create flag')
    failCommand(err)
  }
})

// ── Update ──────────────────────────────────────────────────

const flagsUpdateCommand = withOutputOptions(
  withProjectOption(
    new Command('update')
      .argument('<flag>', 'Flag key, numeric short id, or id')
      .description('Rename a flag or change its description')
      .option('--name <name>', 'New display name')
      .option('--description <text>', 'New description. Pass "" to clear it')
      .option('--key <key>', 'New key (refused once the flag has served traffic)')
      .option(
        '--if-match <version>',
        'Only write if the flag still matches this version (from `avsb flags get`)',
      )
      .option('--force', 'Write without checking the version first'),
  ),
).action(
  async (
    flagRef: string,
    opts: SharedOptions & {
      name?: string
      description?: string
      key?: string
      ifMatch?: string
      force?: boolean
    },
  ) => {
    beginCommand('flags update', opts)
    const session = ensureLoggedIn()
    const project = resolveProjectRefOrExit(opts)

    const patch: UpdateFlagBody = {}
    if (opts.name !== undefined) patch.name = opts.name
    // An empty string is how a shell says "clear it"; the API takes null for that.
    if (opts.description !== undefined) {
      patch.description = opts.description === '' ? null : opts.description
    }
    if (opts.key !== undefined) patch.key = opts.key

    if (Object.keys(patch).length === 0) {
      failCommand(
        new CliError('cli_usage', 'Nothing to update. Pass --name, --description or --key.'),
      )
    }

    const api = new FlagsApiClient(session)
    const spinner = startSpinner('Updating flag...')

    try {
      const { result, resolution } = await withResolvedFlagRef(
        api,
        project.shortId,
        flagRef,
        async (target) => {
          // Read first unless told not to, so the write carries the version it
          // was based on and a concurrent edit is refused rather than
          // overwritten.
          let ifMatch = opts.ifMatch ?? null
          if (!ifMatch && opts.force !== true) {
            const current = await api.getFlag(project.shortId, target.ref)
            ifMatch = current.etag
          }
          return api.updateFlag(project.shortId, target.ref, patch, ifMatch)
        },
      )

      const flag = normalizeFlag(result.body.data)
      spinner.succeed(`Flag updated: ${flag.key}`)

      // `meta.etag` appears only when the response actually carried one: the
      // PATCH route does not send an ETag today, and inventing one would hand a
      // caller a version that means nothing.
      if (emitJsonResult(result.body.data, { etag: result.etag ?? undefined })) return

      const note = describeFlagResolution(flagRef, resolution)
      if (note) logger.dim(note)
      printFlag(flag)
      if (result.etag) logger.dim(`  Version: ${result.etag}`)
    } catch (err) {
      spinner.fail('Failed to update flag')
      failCommand(err)
    }
  },
)

// ── Toggle ──────────────────────────────────────────────────

const flagsToggleCommand = withOutputOptions(
  withProjectOption(
    new Command('toggle')
      .argument('<flag>', 'Flag key, numeric short id, or id')
      .description('Start or stop serving a flag in one environment')
      .requiredOption('--env <environment>', 'Environment key, for example production')
      .option('--on', "Serve the environment's rules again")
      .option('--off', "Stop serving the environment's rules (the kill switch)"),
  ),
).action(
  async (flagRef: string, opts: SharedOptions & { env: string; on?: boolean; off?: boolean }) => {
    beginCommand('flags toggle', opts)

    if (opts.on === opts.off) {
      failCommand(
        new CliError('cli_usage', 'Pass exactly one of --on or --off.', [
          '`--off` stops the environment serving its rules; `--on` starts it again.',
        ]),
      )
    }
    const action = opts.on === true ? 'run' : 'pause'

    const session = ensureLoggedIn()
    const project = resolveProjectRefOrExit(opts)
    const api = new FlagsApiClient(session)
    const spinner = startSpinner('Reading flag...')

    try {
      // The environment endpoints take the environment's own id, so read the
      // flag to turn `--env production` into one. The response is normalized
      // first: only the list route flattens the environment, and reading the
      // flattened name off a `get` body is what used to crash here.
      const { result, resolution } = await withResolvedFlagRef(
        api,
        project.shortId,
        flagRef,
        (target) => api.getFlag(project.shortId, target.ref),
      )
      const flag = normalizeFlag(result.body.data)
      const env = selectEnvConfig(flag, opts.env)

      spinner.stop()
      const applying = startSpinner(action === 'run' ? 'Starting...' : 'Pausing...')
      const response = await api.setFlagEnvState(
        project.shortId,
        resolution.ref,
        env.environmentId,
        action,
      )
      applying.stop()

      if (emitJsonResult(response.data)) return

      const note = describeFlagResolution(flagRef, resolution)
      if (note) logger.dim(note)

      const summary = describeTransition({
        flagKey: flag.key,
        environmentKey: env.environmentKey || env.environmentId,
        action,
        changed: response.data.changed,
        affectedRuleCount: response.data.affectedRules.length,
      })
      if (response.data.changed) logger.success(summary)
      else logger.info(summary)
    } catch (err) {
      spinner.fail('Failed to toggle the flag')
      failCommand(err)
    }
  },
)

export const flagsCommand = new Command('flags')
  .description('List, read, create and toggle feature flags')
  .addCommand(flagsListCommand)
  .addCommand(flagsGetCommand)
  .addCommand(flagsCreateCommand)
  .addCommand(flagsUpdateCommand)
  .addCommand(flagsToggleCommand)
