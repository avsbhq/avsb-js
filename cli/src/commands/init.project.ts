/**
 * Deciding which project, which environment, and which flag `avsb init` sets up
 * against.
 *
 * Split out of the command body because this is the part with questions in it,
 * and every question has a flag that answers it in advance:
 *
 *   --project PRJ-42     link an existing project (no prompt)
 *   --create "My app"    create a feature flags project (no prompt)
 *   --env staging        pick the environment (default production)
 *   --flag checkout_v2   pick the flag the example reads
 *
 * With none of them and no terminal, the command stops and names the two flags
 * rather than hanging on a prompt nobody can answer.
 */

import inquirer from 'inquirer'
import { CliError } from '../lib/cliError.js'
import { ApiRequestError } from '../lib/apiError.js'
import { compareCodeUnits } from '../lib/compareKeys.js'
import * as logger from '../lib/logger.js'
import { parseProjectInput } from '../lib/projectScaffold.js'
import type { InitApiClient } from '../lib/initApi.js'
import type {
  CliDatafileFlag,
  CliFlagEnvironment,
  CliInitDatafile,
  CliPublicProject,
} from '../types/init.js'

/** Default flag key when the project has none yet. Matches the dashboard's. */
export const FALLBACK_FLAG_KEY = 'my_first_flag'

const PROJECT_PAGE_SIZE = 50

export interface ProjectResolutionInput {
  api: InitApiClient
  /** `--project`: a short id, a cuid, or a dashboard URL. */
  projectOption?: string
  /** `--create <name>`: create a feature flags project with this name. */
  createName?: string
  interactive: boolean
}

export interface ProjectResolution {
  project: CliPublicProject
  created: boolean
}

/** Link or create, per the flags and the terminal. */
export async function resolveInitProject(
  input: ProjectResolutionInput,
): Promise<ProjectResolution> {
  if (input.projectOption && input.createName) {
    throw new CliError(
      'cli_usage',
      'Pass either --project (link an existing project) or --create (make a new one), not both.',
    )
  }

  if (input.createName) {
    const created = await createFlagProject(input.api, input.createName)
    return { project: created, created: true }
  }

  if (input.projectOption) {
    return { project: await fetchProject(input.api, input.projectOption), created: false }
  }

  if (!input.interactive) {
    throw new CliError('cli_no_project', 'No project chosen.', [
      'Pass --project PRJ-42 to use an existing project.',
      'Pass --create "My app" to make a new feature flags project.',
      'The short id is the number after /projects/ in the dashboard URL.',
    ])
  }

  return promptForProject(input.api)
}

async function fetchProject(
  api: InitApiClient,
  reference: string,
): Promise<CliPublicProject> {
  let ref: string | number = reference.trim()
  try {
    ref = parseProjectInput(reference)
  } catch {
    // Not a short id or a dashboard URL, so pass it through as a cuid: the API
    // resolves both, and a value that is neither comes back as a clean 404.
  }

  try {
    const response = await api.getProjectByRef(ref)
    return response.data
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) {
      throw new CliError('cli_not_found', `No project ${reference} in this organization.`, [
        'Run `avsb init` with no flags to pick from a list.',
        'The short id is the number after /projects/ in the dashboard URL.',
      ])
    }
    throw err
  }
}

async function createFlagProject(api: InitApiClient, name: string): Promise<CliPublicProject> {
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    throw new CliError('cli_usage', 'A project needs a name: --create "My app".')
  }

  const response = await api.createProject({ name: trimmed, type: 'FEATURE_FLAG' })
  return response.data
}

async function promptForProject(api: InitApiClient): Promise<ProjectResolution> {
  const page = await api.listProjects({ limit: PROJECT_PAGE_SIZE })
  const projects = page.data

  if (page.page.hasMore) {
    logger.dim(
      `  Showing the first ${projects.length} projects. Pass --project PRJ-42 for one further down the list.`,
    )
  }

  const CREATE = '__create__'
  const choices = [
    ...projects.map((project) => ({
      name: `${project.name} (PRJ-${project.shortId}, ${describeProjectType(project)})`,
      value: project.id,
    })),
    { name: 'Create a new feature flags project', value: CREATE },
  ]

  const { chosen } = await inquirer.prompt<{ chosen: string }>([
    {
      type: 'list',
      name: 'chosen',
      message: 'Which project is this?',
      choices,
    },
  ])

  if (chosen !== CREATE) {
    const project = projects.find((candidate) => candidate.id === chosen)
    if (!project) {
      throw new CliError('cli_not_found', 'That project is no longer in the list.')
    }
    return { project, created: false }
  }

  const { name } = await inquirer.prompt<{ name: string }>([
    {
      type: 'input',
      name: 'name',
      message: 'Name for the new project:',
      validate: (value: string) => value.trim().length > 0 || 'A project needs a name',
    },
  ])

  return { project: await createFlagProject(api, name), created: true }
}

function describeProjectType(project: CliPublicProject): string {
  return project.type === 'FEATURE_FLAG' ? 'feature flags' : 'web experiments'
}

/**
 * The environment whose SDK key gets written, or null for a web experiments
 * project (which has no environments and no SDK key: it installs the snippet).
 */
export async function resolveInitEnvironment(
  api: InitApiClient,
  project: CliPublicProject,
  environmentKey: string,
): Promise<CliFlagEnvironment | null> {
  if (project.type !== 'FEATURE_FLAG') return null

  const response = await api.listEnvironments(project.shortId)
  const environments = response.data
  const match = environments.find((environment) => environment.key === environmentKey)

  if (!match) {
    const known = environments.map((environment) => environment.key)
    throw new CliError(
      'cli_not_found',
      `No environment "${environmentKey}" in PRJ-${project.shortId}.`,
      known.length > 0
        ? [`Environments in this project: ${known.join(', ')}.`, 'Pick one with --env <key>.']
        : ['This project has no environments yet. Create one on the Environments page.'],
    )
  }

  return match
}

export interface FlagResolution {
  flagKey: string
  /** The datafile entry, when the flag is really there. */
  flag: CliDatafileFlag | null
  /** The whole datafile, when it could be read. */
  datafile: CliInitDatafile | null
}

/**
 * Which flag the example reads.
 *
 * A named flag must exist: writing an example against a key that is not there
 * would hand the developer a fallback value and no way to know why. With no
 * name, the project's first flag is used, and a project with no flags gets the
 * documented placeholder plus a line saying to create it.
 */
export async function resolveSampleFlag(
  api: InitApiClient,
  projectShortId: number,
  environmentKey: string,
  requested: string | undefined,
): Promise<FlagResolution> {
  let datafile: CliInitDatafile | null = null

  try {
    datafile = await api.getInitDatafile(projectShortId, environmentKey)
  } catch (err) {
    // The example is still worth writing without it; only the proof line and
    // the flag list depend on the datafile.
    const reason = err instanceof Error ? err.message : 'unknown error'
    logger.warn(`Could not read the datafile for ${environmentKey}: ${reason}`)
  }

  const flags = datafile?.flags ?? []

  if (requested) {
    const match = flags.find((flag) => flag.key === requested)
    if (!match && datafile) {
      throw new CliError(
        'cli_not_found',
        `No flag "${requested}" in PRJ-${projectShortId} (${environmentKey}).`,
        flags.length > 0
          ? [`Flags here: ${flags.slice(0, 8).map((flag) => flag.key).join(', ')}.`]
          : ['This project has no flags yet. Create one with `avsb flags create <key>`.'],
      )
    }
    return { flagKey: requested, flag: match ?? null, datafile }
  }

  if (flags.length === 0) {
    return { flagKey: FALLBACK_FLAG_KEY, flag: null, datafile }
  }

  // Code-unit order, not the locale's: which flag the example reads must not
  // depend on the locale the terminal happens to be running in.
  const first = [...flags].sort((a, b) => compareCodeUnits(a.key, b.key))[0]
  return { flagKey: first.key, flag: first, datafile }
}
