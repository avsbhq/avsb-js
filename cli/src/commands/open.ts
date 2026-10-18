/**
 * `avsb open [target]` — jump from the terminal to the matching dashboard page.
 *
 * The URL rules are pure (`resolveOpenTarget`) so they can be tested, printed
 * with `--url`, and reused: nothing here needs the network, and a headless
 * machine can still ask for the link.
 */

import { Command } from 'commander'
import { spawn } from 'node:child_process'
import { ensureLoggedIn } from '../lib/config.js'
import { CliError } from '../lib/cliError.js'
import * as logger from '../lib/logger.js'
import { beginCommand, emitJsonResult, failCommand, withOutputOptions } from '../lib/output.js'
import { resolveProjectRef, type ProjectRef } from '../lib/projectRef.js'

/** What `avsb open` knows how to reach, with the words a user would try. */
export const OPEN_TARGETS = [
  'dashboard',
  'experiments',
  'flags',
  'environments',
  'metrics',
  'datasets',
  'settings',
  'snippet',
  'docs',
  'tokens',
] as const

export type OpenTarget = (typeof OPEN_TARGETS)[number]

export interface OpenResolution {
  url: string
  /** What the URL points at, for the printed line. */
  label: string
}

function isOpenTarget(value: string): value is OpenTarget {
  return (OPEN_TARGETS as readonly string[]).includes(value)
}

/**
 * The URL for one target.
 *
 * `EXP-42` and `PRJ-7` are accepted directly, because those are the ids the CLI
 * prints everywhere else; anything else must be one of `OPEN_TARGETS`. A target
 * that needs a project asks for one the same way every other command does.
 */
export function resolveOpenTarget(
  raw: string | undefined,
  baseUrl: string,
  project: () => ProjectRef,
): OpenResolution {
  const target = (raw ?? 'dashboard').trim()

  const experimentMatch = target.match(/^exp-(\d+)$/i)
  if (experimentMatch) {
    const projectShortId = project().shortId
    return {
      url: `${baseUrl}/projects/${projectShortId}/experiments/${experimentMatch[1]}`,
      label: `experiment EXP-${experimentMatch[1]}`,
    }
  }

  const projectMatch = target.match(/^prj-(\d+)$/i)
  if (projectMatch) {
    return {
      url: `${baseUrl}/projects/${projectMatch[1]}/dashboard`,
      label: `project PRJ-${projectMatch[1]}`,
    }
  }

  if (!isOpenTarget(target.toLowerCase())) {
    throw new CliError('cli_usage', `Cannot open "${target}".`, [
      `Try one of: ${OPEN_TARGETS.join(', ')}.`,
      'Or name a thing directly: `avsb open EXP-42`, `avsb open PRJ-7`.',
    ])
  }

  const named = target.toLowerCase() as OpenTarget

  // `docs` and `tokens` are account-level, so they never ask for a project. The
  // rest resolve one lazily, which is why `project` is a function.
  switch (named) {
    case 'docs':
      return { url: `${baseUrl}/docs/developer-reference/cli-tool`, label: 'the CLI documentation' }
    case 'tokens':
      return { url: `${baseUrl}/account?tab=tokens`, label: 'your personal access tokens' }
    case 'dashboard':
      return projectUrl(baseUrl, project, '/dashboard', (id) => `the PRJ-${id} dashboard`)
    case 'experiments':
      return projectUrl(baseUrl, project, '/experiments', (id) => `experiments in PRJ-${id}`)
    case 'flags':
      return projectUrl(baseUrl, project, '/flags', (id) => `flags in PRJ-${id}`)
    case 'environments':
      return projectUrl(
        baseUrl,
        project,
        '/environments',
        (id) => `environments and SDK keys in PRJ-${id}`,
      )
    case 'metrics':
      return projectUrl(baseUrl, project, '/metrics', (id) => `metrics in PRJ-${id}`)
    case 'datasets':
      return projectUrl(baseUrl, project, '/commerce/datasets', (id) => `datasets in PRJ-${id}`)
    case 'settings':
      return projectUrl(baseUrl, project, '/settings', (id) => `settings for PRJ-${id}`)
    case 'snippet':
      return projectUrl(
        baseUrl,
        project,
        '/settings?tab=snippet',
        (id) => `the install snippet for PRJ-${id}`,
      )
  }
}

/** One project-scoped URL, resolving the project only when it is needed. */
function projectUrl(
  baseUrl: string,
  project: () => ProjectRef,
  suffix: string,
  label: (projectShortId: number) => string,
): OpenResolution {
  const projectShortId = project().shortId
  return { url: `${baseUrl}/projects/${projectShortId}${suffix}`, label: label(projectShortId) }
}

/** The command that opens a URL on this operating system. */
export function browserCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === 'darwin') return { command: 'open', args: [] }
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] }
  return { command: 'xdg-open', args: [] }
}

function openInBrowser(url: string): void {
  const { command, args } = browserCommand(process.platform)
  // Detached and ignored: the browser outliving the CLI is the point, and its
  // own output must not land in ours.
  const child = spawn(command, [...args, url], { stdio: 'ignore', detached: true })
  child.on('error', () => {
    logger.warn(`Could not launch a browser. Open this yourself: ${url}`)
  })
  child.unref()
}

/** Resolution rules stay pure; this turns a refusal into the standard exit. */
function resolveOrExit(
  target: string | undefined,
  baseUrl: string,
  opts: { project?: string },
): OpenResolution {
  try {
    return resolveOpenTarget(target, baseUrl, () => resolveProjectRef(opts))
  } catch (err) {
    failCommand(err)
  }
}

export const openCommand = withOutputOptions(
  new Command('open')
    .description('Open a dashboard page in your browser')
    .argument(
      '[target]',
      `What to open: ${OPEN_TARGETS.join(' | ')}, or an id like EXP-42 or PRJ-7`,
      'dashboard',
    )
    .option('--project <project>', 'Project ID (PRJ-42 or numeric); defaults to local manifest')
    .option('--url', 'Print the URL instead of opening a browser'),
).action(
  (
    target: string | undefined,
    opts: { project?: string; url?: boolean; json?: boolean; quiet?: boolean },
  ) => {
    beginCommand('open', opts)
    const session = ensureLoggedIn()
    const resolution = resolveOrExit(target, session.apiBaseUrl, opts)

    if (emitJsonResult({ url: resolution.url, target: target ?? 'dashboard' })) return

    // `--url` is for the caller who wants the link, not the browser: a remote
    // shell, a script, a note to a colleague.
    if (opts.url === true) {
      logger.line(resolution.url)
      return
    }

    logger.info(`Opening ${resolution.label}`)
    logger.dim(`  ${resolution.url}`)
    openInBrowser(resolution.url)
  },
)
