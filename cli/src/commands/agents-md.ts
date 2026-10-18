/**
 * `avsb agents-md install` — teach the coding agents working in this repository
 * what A vs B is.
 *
 * Claude Code reads CLAUDE.md, most other agents read AGENTS.md, and an agent
 * that has read neither will invent flag keys, paste a personal access token
 * into browser code, and write evaluation calls against an API that does not
 * exist. This command writes one marker-delimited section into those files with
 * the credential vocabulary, the command list, and the evaluation rules.
 *
 * Re-running it REPLACES the section rather than appending a second copy, so it
 * is safe in a postinstall script or a Makefile. Everything outside the markers
 * is left byte for byte as it was.
 *
 * It makes no network calls: the section is generated from what is on disk, so
 * it works offline and needs no login.
 */

import fs from 'node:fs'
import path from 'node:path'
import { Command } from 'commander'
import {
  AGENTS_FILES,
  applyAgentsSection,
  describeAgentsWrite,
  renderAgentsSection,
  type AgentsFileName,
  type AgentsWriteOutcome,
} from '../lib/agentsMd.js'
import { CliError } from '../lib/cliError.js'
import { detectFramework, parsePackageJson } from '../lib/frameworkDetect.js'
import { buildFrameworkProfile } from '../lib/frameworkProfiles.js'
import * as logger from '../lib/logger.js'
import { beginCommand, emitJsonResult, failCommand, withOutputOptions } from '../lib/output.js'
import { parseProjectInput } from '../lib/projectScaffold.js'
import { readFileOrNull } from './init.write.js'

interface AgentsMdOptions {
  dir: string
  claude?: boolean
  agents?: boolean
  print?: boolean
  project?: string
  env: string
  json?: boolean
  quiet?: boolean
}

/** Which files this run touches. Neither flag means both, because the two file
 *  names are two conventions for the same thing. */
export function chooseTargets(options: { claude?: boolean; agents?: boolean }): AgentsFileName[] {
  if (options.claude && !options.agents) return ['CLAUDE.md']
  if (options.agents && !options.claude) return ['AGENTS.md']
  return [...AGENTS_FILES]
}

/** The project short id for the section header, or null when nothing names one. */
export function readProjectShortId(value: string | undefined): number | null {
  if (!value) return null
  try {
    return parseProjectInput(value)
  } catch {
    throw new CliError('cli_usage', `Invalid --project value "${value}".`, [
      'Pass the project short id: --project PRJ-42, or --project 42.',
    ])
  }
}

const agentsMdInstallCommand = withOutputOptions(
  new Command('install')
    .description('Write the A vs B section into CLAUDE.md and AGENTS.md')
    .option('-d, --dir <path>', 'Repository directory to write into', '.')
    .option('--claude', 'Only CLAUDE.md')
    .option('--agents', 'Only AGENTS.md')
    .option('--print', 'Print the section instead of writing it')
    .option('-p, --project <project>', 'Project to name in the section: PRJ-42 or 42')
    .option('-e, --env <environment>', 'Environment to name in the section', 'production'),
).action((opts: AgentsMdOptions) => {
  beginCommand('agents-md install', opts)

  try {
    const dir = path.resolve(opts.dir ?? '.')
    const pkg = parsePackageJson(readFileOrNull(path.join(dir, 'package.json')) ?? '')
    const profile = buildFrameworkProfile(detectFramework(pkg))

    const section = renderAgentsSection({
      projectShortId: readProjectShortId(opts.project),
      environmentKey: opts.env,
      sdkKeyEnvVar: profile.envVar,
      sdkPackage: profile.sdkPackage,
    })

    if (opts.print) {
      if (emitJsonResult({ printed: true, section })) return
      logger.line(section)
      return
    }

    const written = chooseTargets(opts).map((file) => writeTarget(dir, file, section))

    if (emitJsonResult({ printed: false, files: written })) return

    for (const result of written) {
      logger.success(describeAgentsWrite(result.outcome, result.path))
    }
    logger.dim('  Re-run this command any time: it replaces the section instead of adding a second one.')
  } catch (err) {
    failCommand(err)
  }
})

function writeTarget(
  dir: string,
  file: AgentsFileName,
  section: string,
): { path: string; outcome: AgentsWriteOutcome } {
  const filePath = path.join(dir, file)
  const existing = readFileOrNull(filePath)
  const applied = applyAgentsSection(existing, section)

  if (applied.outcome !== 'unchanged') {
    try {
      fs.writeFileSync(filePath, applied.content, 'utf-8')
    } catch (err) {
      throw new CliError(
        'cli_io_failed',
        `Could not write ${filePath}: ${err instanceof Error ? err.message : 'unknown error'}`,
      )
    }
  }

  return { path: filePath, outcome: applied.outcome }
}

export const agentsMdCommand = new Command('agents-md').description(
  'Write A vs B instructions for coding agents into CLAUDE.md and AGENTS.md',
)

agentsMdCommand.addCommand(agentsMdInstallCommand)
