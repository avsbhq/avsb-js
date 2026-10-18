/**
 * The `avsb` entry point.
 *
 * Two things happen here that nothing else can do:
 *   - commander's own failures (unknown option, missing argument, unknown
 *     command) are mapped to exit code 2, so "you typed it wrong" is
 *     distinguishable from "it ran and failed". `--help` and `--version` stay 0.
 *   - the update notice fires after the command finishes, never before, and only
 *     for an interactive run.
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { Command, CommanderError } from 'commander'
// ── session 28 (avsb init) imports: keep contiguous ──
import { initCommand } from './commands/init.js'
import { agentsMdCommand } from './commands/agents-md.js'
// ── end session 28 imports ──
import { loginCommand } from './commands/login.js'
import { logoutCommand } from './commands/logout.js'
import { whoamiCommand } from './commands/whoami.js'
import { orgCommand } from './commands/org.js'
import { cloneCommand } from './commands/clone.js'
import { pullCommand } from './commands/pull.js'
import { pushCommand } from './commands/push.js'
import { devCommand } from './commands/dev.js'
import { statusCommand } from './commands/status.js'
import { projectCommand } from './commands/project.js'
import { metricsCommand } from './commands/metrics.js'
import { metricBindingsCommand } from './commands/metric-bindings.js'
// ── session 29 (typed-codegen) imports: keep contiguous ──
import { codegenCommand } from './commands/codegen.js'
import { findRefsCommand } from './commands/find-refs.js'
// ── end session 29 imports ──
import { datasetsCommand } from './commands/datasets.js'
import { listenCommand } from './commands/listen.js'
import { triggerCommand } from './commands/trigger.js'
import { flagsCommand } from './commands/flags.js'
import { experimentsCommand } from './commands/experiments.js'
import { openCommand } from './commands/open.js'
import { buildCompletionCommand } from './commands/completion.js'
import { EXIT, EXIT_CODE_HELP } from './lib/exitCodes.js'
import { checkForUpdate } from './lib/updateNotifier.js'
import { writeErr } from './lib/outputMode.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')) as { version: string }

const program = new Command()

program
  .name('avsb')
  .description(
    'A vs B command line tool: experiments, flags, project scripts, metrics, datasets, webhooks, and typed flags',
  )
  .version(pkg.version)
  .addHelpText(
    'after',
    `
Machine-readable output:
  --json         Print one JSON document on stdout: {"ok":true,"command":…,"data":…}
                 or {"ok":false,"command":…,"error":{"code","message","docUrl"}}.
  --quiet        Print the result only. Warnings and errors still go to stderr.
  Results go to stdout, everything else to stderr, in every mode.

Exit codes:
${EXIT_CODE_HELP}

Environment variables:
  AVSB_TOKEN     Personal access token. Used instead of the saved login, so no
                 \`avsb login\` is needed in CI.
  AVSB_API_URL   Platform base URL. Defaults to https://app.avsb.cloud.
  AVSB_JSON      Set to 1 for --json without passing the flag.
  AVSB_QUIET     Set to 1 for --quiet without passing the flag.
  AVSB_NO_UPDATE_NOTIFIER
                 Set to 1 to never check for a newer CLI version.

Saved logins live in plain text at ~/.avsb/config.json (file mode 0600).
Docs: https://app.avsb.cloud/docs/developer-reference/cli-tool
`,
  )

// ── session 28 (avsb init) registration: keep contiguous ──
// First in the list on purpose: `avsb init` is the command a new developer runs
// before any of the others exist for them.
program.addCommand(initCommand)
program.addCommand(agentsMdCommand)
// ── end session 28 registration ──

program.addCommand(loginCommand)
program.addCommand(logoutCommand)
program.addCommand(whoamiCommand)
program.addCommand(orgCommand)
program.addCommand(cloneCommand)
program.addCommand(pullCommand)
program.addCommand(pushCommand)
program.addCommand(devCommand)
program.addCommand(statusCommand)
program.addCommand(projectCommand)
program.addCommand(experimentsCommand)
program.addCommand(flagsCommand)
program.addCommand(metricsCommand)
program.addCommand(metricBindingsCommand)
// ── session 29 (typed-codegen) commands: keep contiguous ──
program.addCommand(codegenCommand)
program.addCommand(findRefsCommand)
// ── end session 29 commands ──
program.addCommand(datasetsCommand)
program.addCommand(listenCommand)
program.addCommand(triggerCommand)
program.addCommand(openCommand)
program.addCommand(buildCompletionCommand(program))

/**
 * Which exit code a commander failure deserves.
 *
 * Help and version are successful outcomes even though commander throws to
 * unwind; everything else commander raises is the caller getting the syntax
 * wrong, which is exit 2.
 */
export function exitCodeForCommanderError(error: CommanderError): number {
  if (error.exitCode === 0) return EXIT.success
  return EXIT.usage
}

/**
 * Every command, not just the root: `addCommand` does not pass this setting
 * down, so `avsb flags list --bogus` would otherwise exit through commander's
 * own handler and skip the mapping.
 */
function applyExitOverride(command: Command): void {
  command.exitOverride()
  for (const child of command.commands) applyExitOverride(child)
}

async function main(): Promise<void> {
  // Commander exits the process itself by default, which would skip the mapping
  // below and the update notice.
  applyExitOverride(program)

  try {
    await program.parseAsync()
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exit(exitCodeForCommanderError(err))
    }
    // Nothing else should reach here: commands report their own failures. An
    // unexpected throw is still a failure, and stays visible rather than being
    // swallowed by an unhandled rejection.
    writeErr(err instanceof Error ? err.message : 'Command failed')
    process.exit(EXIT.failure)
  }

  await checkForUpdate(pkg.version, (message) => writeErr(message))
}

await main()
