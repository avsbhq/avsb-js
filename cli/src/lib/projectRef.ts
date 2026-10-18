/**
 * Which project a command works on, and where that answer came from.
 *
 * Three sources, in this order:
 *   1. `--project PRJ-42` (also accepts `42` or a dashboard URL)
 *   2. `.avsb-project.json`, written by `avsb project pull`
 *   3. `.avsb.json`, written by `avsb clone`
 *
 * The third source is why this module exists: `avsb codegen` used to demand
 * `--project` even when run inside a cloned experiment folder that already
 * records its project, while the metrics and datasets commands resolved it
 * from disk (report 06 §5). Every project-scoped command now answers the
 * question the same way, and says which file it read.
 *
 * The lookups are injectable so the rules can be tested without a filesystem.
 */

import { CliError } from './cliError.js'
import { findManifest } from './manifest.js'
import { failCommand } from './output.js'
import { findProjectManifestDir, parseProjectInput, readProjectManifest } from './projectScaffold.js'

export type ProjectRefSource = 'flag' | 'project-manifest' | 'experiment-manifest'

export interface ProjectRef {
  shortId: number
  source: ProjectRefSource
}

export interface ProjectRefLookups {
  /** `.avsb-project.json` in this directory or above it, or null. */
  projectManifest: () => { projectShortId: number } | null
  /** `.avsb.json` in this directory or above it, or null. */
  experimentManifest: () => { projectShortId: number } | null
}

const defaultLookups: ProjectRefLookups = {
  projectManifest: () => {
    const dir = findProjectManifestDir()
    return dir ? readProjectManifest(dir) : null
  },
  experimentManifest: () => findManifest(),
}

/** Where the project came from, for a one-line note under the result. */
export function describeProjectSource(ref: ProjectRef): string {
  switch (ref.source) {
    case 'flag':
      return `project PRJ-${ref.shortId} (from --project)`
    case 'project-manifest':
      return `project PRJ-${ref.shortId} (from .avsb-project.json)`
    case 'experiment-manifest':
      return `project PRJ-${ref.shortId} (from .avsb.json)`
  }
}

/**
 * Resolve the project for this run, or throw a `CliError` explaining every way
 * to name one.
 */
export function resolveProjectRef(
  opts: { project?: string },
  lookups: ProjectRefLookups = defaultLookups,
): ProjectRef {
  if (opts.project) {
    try {
      return { shortId: parseProjectInput(opts.project), source: 'flag' }
    } catch {
      throw new CliError(
        'cli_usage',
        `Invalid --project value "${opts.project}".`,
        [
          'Pass the project short id: --project PRJ-42, or --project 42.',
          'It is the number after /projects/ in the dashboard URL, and the number on the project card.',
        ],
      )
    }
  }

  const fromProject = lookups.projectManifest()
  if (fromProject) {
    return { shortId: fromProject.projectShortId, source: 'project-manifest' }
  }

  const fromExperiment = lookups.experimentManifest()
  if (fromExperiment) {
    return { shortId: fromExperiment.projectShortId, source: 'experiment-manifest' }
  }

  throw new CliError('cli_no_project', 'No project specified.', [
    'Pass --project PRJ-42, or run the command inside a folder created by `avsb clone` or `avsb project pull`.',
    'The project short id is the number after /projects/ in the dashboard URL.',
  ])
}

/**
 * `resolveProjectRef`, but a failure ends the command with the standard
 * envelope and exit code instead of throwing. What commands call.
 */
export function resolveProjectRefOrExit(
  opts: { project?: string },
  lookups?: ProjectRefLookups,
): ProjectRef {
  try {
    return resolveProjectRef(opts, lookups)
  } catch (err) {
    failCommand(err)
  }
}
