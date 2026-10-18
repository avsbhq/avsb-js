/**
 * `avsb find-refs` — which flags does this codebase still use?
 *
 * Answers two questions in one pass:
 *   - which keys the code asks for that the platform cannot serve (renamed,
 *     deleted, or archived), which is a silent default served to real users;
 *   - which flags exist and nothing reads, which is the deletion list.
 *
 * Read-only and offline apart from one flag-list call. It never writes, never
 * follows symlinks out of the tree, and stops at a file budget rather than
 * walking a monorepo forever.
 *
 * The scanning rules live in `lib/findRefs.ts` and `lib/ignoreRules.ts`; this
 * file walks, calls, and prints.
 */

import { Command } from 'commander'
import fs from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import { ensureLoggedIn } from '../lib/config.js'
import { CliError } from '../lib/cliError.js'
import { EXIT } from '../lib/exitCodes.js'
import * as logger from '../lib/logger.js'
import { startSpinner } from '../lib/outputMode.js'
import { beginCommand, emitJsonResult, failCommand, withOutputOptions } from '../lib/output.js'
import { describeProjectSource, resolveProjectRefOrExit } from '../lib/projectRef.js'
import { FlagsApiClient } from '../lib/flagsApi.js'
import {
  buildReport,
  scanFileForReferences,
  type FindRefsReport,
  type FlagReference,
  type RegistryFlag,
} from '../lib/findRefs.js'
import {
  ALWAYS_SKIPPED_DIRECTORIES,
  isIgnored,
  parseIgnoreFile,
  toRelativePosix,
  type IgnoreRule,
} from '../lib/ignoreRules.js'

/** Extensions worth reading. Everything else is data, assets, or build output. */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.svelte',
  '.astro',
  '.html',
  '.py',
  '.rb',
  '.php',
  '.go',
  '.java',
  '.kt',
  '.cs',
  '.swift',
  '.json',
  '.yaml',
  '.yml',
])

const DEFAULT_MAX_FILES = 5000
/** A source file bigger than this is generated, minified, or not source. */
const MAX_FILE_BYTES = 1_000_000
/** Pages of 100 flags; a project with more than this is not a real project. */
const MAX_FLAG_PAGES = 20

interface FindRefsOptions {
  project?: string
  dir: string
  ignore?: string[]
  maxFiles?: string
  strict?: boolean
  json?: boolean
  quiet?: boolean
}

interface ScanResult {
  references: FlagReference[]
  filesScanned: number
  /** True when the budget stopped the walk before the tree ran out. */
  truncated: boolean
}

/**
 * Read every flag the platform has, following the cursor.
 *
 * The datafile would have been the cheaper source, but it only carries flags
 * PUBLISHED to one environment: a flag created this morning and not yet
 * published would be reported as extinct, which is the one wrong answer this
 * command must never give.
 */
async function readRegistry(api: FlagsApiClient, projectShortId: number): Promise<RegistryFlag[]> {
  const flags: RegistryFlag[] = []
  let cursor: string | undefined

  for (let page = 0; page < MAX_FLAG_PAGES; page += 1) {
    const response = await api.listFlags(projectShortId, { limit: 100, cursor })
    for (const flag of response.data) {
      flags.push({ key: flag.key, status: flag.status, stale: flag.stale })
    }
    if (!response.page.hasMore || !response.page.nextCursor) return flags
    cursor = response.page.nextCursor
  }

  throw new CliError(
    'cli_failed',
    `Stopped after ${MAX_FLAG_PAGES} pages of flags. Report this: a project should not have that many.`,
  )
}

async function scanTree(
  root: string,
  extraRules: readonly IgnoreRule[],
  knownKeys: ReadonlySet<string>,
  maxFiles: number,
): Promise<ScanResult> {
  const references: FlagReference[] = []
  let filesScanned = 0
  let truncated = false

  async function walk(dir: string, inherited: readonly IgnoreRule[]): Promise<void> {
    if (truncated) return

    let entries: Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      // An unreadable directory is skipped, not fatal: a scan that dies on one
      // permission error in a monorepo reports nothing at all.
      return
    }

    let rules = inherited
    if (entries.some((e) => e.isFile() && e.name === '.gitignore')) {
      const contents = await readTextFile(path.join(dir, '.gitignore'))
      if (contents !== null) {
        rules = [...inherited, ...parseIgnoreFile(contents, toRelativePosix(root, dir))]
      }
    }

    for (const entry of entries) {
      if (truncated) return
      // Symlinks are not followed: a link into node_modules or back up the tree
      // turns a bounded walk into an unbounded one.
      if (entry.isSymbolicLink()) continue

      const full = path.join(dir, entry.name)
      const rel = toRelativePosix(root, full)

      if (entry.isDirectory()) {
        if (ALWAYS_SKIPPED_DIRECTORIES.includes(entry.name)) continue
        if (isIgnored(rel, true, rules)) continue
        await walk(full, rules)
        continue
      }

      if (!entry.isFile()) continue
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue
      if (isIgnored(rel, false, rules)) continue

      if (filesScanned >= maxFiles) {
        truncated = true
        return
      }

      const contents = await readTextFile(full)
      if (contents === null) continue
      filesScanned += 1
      references.push(...scanFileForReferences(contents, rel, knownKeys))
    }
  }

  await walk(root, extraRules)
  return { references, filesScanned, truncated }
}

/** File contents, or null when it is too big, binary, or unreadable. */
async function readTextFile(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath)
    if (stat.size > MAX_FILE_BYTES) return null
    const contents = await fs.readFile(filePath, 'utf-8')
    // A NUL byte means this is not text, whatever the extension claims.
    return contents.includes('\0') ? null : contents
  } catch {
    return null
  }
}

function renderReport(report: FindRefsReport, truncated: boolean, maxFiles: number): void {
  logger.line()

  if (report.extinct.length === 0) {
    logger.success('No code references a flag the platform cannot serve.')
  } else {
    logger.error(
      `${report.extinct.length} flag key${report.extinct.length === 1 ? '' : 's'} referenced but not servable:`,
    )
    for (const item of report.extinct) {
      const why = item.reason === 'archived' ? 'archived on the platform' : 'not on the platform'
      logger.errorDetail(`${item.key} (${why})`)
      for (const ref of item.references.slice(0, 5)) {
        logger.errorDetail(`  ${ref.file}:${ref.line}`)
      }
      if (item.references.length > 5) {
        logger.errorDetail(`  and ${item.references.length - 5} more`)
      }
    }
  }

  logger.line()
  if (report.unreferenced.length === 0) {
    logger.info('Every flag on the platform is referenced somewhere.')
  } else {
    logger.info(
      `${report.unreferenced.length} flag${report.unreferenced.length === 1 ? '' : 's'} no scanned file references:`,
    )
    for (const flag of report.unreferenced) {
      const marks = [flag.status.toLowerCase(), flag.stale ? 'marked stale' : null]
        .filter((m): m is string => m !== null)
        .join(', ')
      logger.dim(`  ${flag.key} (${marks})`)
    }
  }

  logger.line()
  logger.label('Files scanned', String(report.filesScanned))
  logger.label('Flags in use', String(report.matchedKeys.length))
  if (truncated) {
    logger.warn(
      `Stopped at the ${maxFiles}-file limit, so the unreferenced list may be incomplete. Raise it with --max-files.`,
    )
  }
}

export const findRefsCommand = withOutputOptions(
  new Command('find-refs')
    .description('Find flag keys in your source and compare them with the platform')
    .option(
      '-p, --project <project>',
      'project short id (PRJ-42 or 42); defaults to the local .avsb-project.json or .avsb.json',
    )
    .option('-d, --dir <path>', 'directory to scan', '.')
    .option(
      '-i, --ignore <pattern>',
      'gitignore-style pattern to skip; repeatable',
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option('--max-files <count>', `stop after this many files (default ${DEFAULT_MAX_FILES})`)
    .option('--strict', 'exit non-zero when code references a flag the platform cannot serve'),
).action(async (opts: FindRefsOptions) => {
  beginCommand('find-refs', opts)

  const maxFiles = parseMaxFiles(opts.maxFiles)
  if (typeof maxFiles === 'string') failCommand(new CliError('cli_usage', maxFiles))

  const project = resolveProjectRefOrExit(opts)
  const config = ensureLoggedIn()
  const spinner = startSpinner('Reading flags...')

  try {
    const api = new FlagsApiClient(config)
    const registry = await readRegistry(api, project.shortId)
    spinner.succeed(`Read ${registry.length} flag${registry.length === 1 ? '' : 's'}`)

    const root = path.resolve(opts.dir)
    await assertDirectory(root, opts.dir)

    const extraRules = (opts.ignore ?? []).flatMap((pattern) => parseIgnoreFile(pattern))
    const knownKeys = new Set(registry.map((f) => f.key))
    const scan = await scanTree(root, extraRules, knownKeys, maxFiles)
    const report = buildReport(registry, scan.references, scan.filesScanned)

    if (
      emitJsonResult({
        ...report,
        root,
        truncated: scan.truncated,
        projectShortId: project.shortId,
        projectSource: project.source,
      })
    ) {
      if (opts.strict && report.extinct.length > 0) process.exit(EXIT.failure)
      return
    }

    logger.heading(`Flag references in ${root}`)
    logger.dim(`  Compared against ${describeProjectSource(project)}`)
    renderReport(report, scan.truncated, maxFiles)

    if (opts.strict && report.extinct.length > 0) process.exit(EXIT.failure)
  } catch (err) {
    spinner.fail('Scan failed')
    failCommand(err)
  }
})

/** The parsed count, or the reason it was refused. */
function parseMaxFiles(raw: string | undefined): number | string {
  if (raw === undefined) return DEFAULT_MAX_FILES
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    return `Invalid --max-files value "${raw}". Pass a whole number above zero.`
  }
  return value
}

async function assertDirectory(root: string, asTyped: string): Promise<void> {
  try {
    const stat = await fs.stat(root)
    if (stat.isDirectory()) return
  } catch {
    // Falls through to the same message: absent and not-a-directory are the
    // same problem from where the caller is standing.
  }
  throw new CliError('cli_usage', `Cannot scan "${asTyped}": it is not a directory.`)
}
