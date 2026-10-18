/**
 * `avsb codegen` — turn this project's live flags into TypeScript.
 *
 * Three modes, one generator:
 *   - default: fetch the datafile, write the files.
 *   - `--check`: generate in memory, compare to disk, exit non-zero on drift.
 *     What a CI job runs so a flag renamed on the platform fails the build
 *     instead of silently serving a default to real users.
 *   - `--watch`: poll and rewrite while you work.
 *
 * `--manifest` adds a JSON twin of the same facts, for the CI steps and
 * scripts that cannot read TypeScript.
 *
 * The emitters live in `lib/codegenEmit.ts` (types), `lib/codegenManifest.ts`
 * (JSON) and `lib/codegenCheck.ts` (the comparison); this file is the wiring:
 * fetch, write, report, exit.
 */

import { Command } from 'commander'
import path from 'node:path'
import fs from 'node:fs/promises'
import { ensureLoggedIn } from '../lib/config.js'
import { CliError } from '../lib/cliError.js'
import { EXIT, type ExitCode } from '../lib/exitCodes.js'
import * as logger from '../lib/logger.js'
import { isJsonOutput, startSpinner } from '../lib/outputMode.js'
import { beginCommand, emitJsonResult, failCommand, withOutputOptions } from '../lib/output.js'
import { describeProjectSource, resolveProjectRefOrExit } from '../lib/projectRef.js'
import { CodegenApiClient } from '../lib/codegenApi.js'
import { emitTypes, type CodegenDatafile } from '../lib/codegenEmit.js'
import { buildManifest, serialiseManifest } from '../lib/codegenManifest.js'
import {
  describeDrift,
  describeDriftSummary,
  diffArtifacts,
  type CodegenArtifact,
} from '../lib/codegenCheck.js'
import {
  parseWatchInterval,
  runWatchLoop,
  type WatchEvent,
} from '../lib/codegenWatch.js'

interface CodegenOptions {
  output: string
  project?: string
  env: string
  manifest?: string
  augment?: boolean
  check?: boolean
  watch?: boolean
  interval?: string
  json?: boolean
  quiet?: boolean
}

/** One generated file: where it goes and what belongs in it. */
interface Artifact {
  path: string
  contents: string
}

/** Everything the emitters need that does not come from the datafile. */
interface GenerationTargets {
  typesPath: string
  manifestPath: string | null
  projectShortId: number
  env: string
  augment: boolean
}

function planArtifacts(datafile: CodegenDatafile, targets: GenerationTargets): Artifact[] {
  const artifacts: Artifact[] = [
    {
      path: targets.typesPath,
      contents: emitTypes(datafile, {
        projectId: String(targets.projectShortId),
        env: targets.env,
        augment: targets.augment,
      }),
    },
  ]

  if (targets.manifestPath) {
    artifacts.push({
      path: targets.manifestPath,
      contents: serialiseManifest(
        buildManifest({
          datafile,
          projectShortId: targets.projectShortId,
          environmentKey: targets.env,
        }),
      ),
    })
  }

  return artifacts
}

/** The file's contents, or null when it is not there. Any other error stands. */
async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if (isMissingFile(err)) return null
    throw err
  }
}

function isMissingFile(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT'
}

/**
 * Write the artifacts that differ, and report which ones those were.
 *
 * Files that already match are left alone rather than rewritten with identical
 * bytes: watch mode would otherwise retrigger every file watcher in the
 * project's own dev server on every poll.
 */
async function writeArtifacts(artifacts: readonly Artifact[]): Promise<string[]> {
  const written: string[] = []
  for (const artifact of artifacts) {
    const existing = await readIfPresent(artifact.path)
    if (existing === artifact.contents) continue
    await fs.mkdir(path.dirname(artifact.path), { recursive: true })
    await fs.writeFile(artifact.path, artifact.contents, 'utf-8')
    written.push(artifact.path)
  }
  return written
}

async function toComparisons(artifacts: readonly Artifact[]): Promise<CodegenArtifact[]> {
  const comparisons: CodegenArtifact[] = []
  for (const artifact of artifacts) {
    comparisons.push({
      path: artifact.path,
      expected: artifact.contents,
      actual: await readIfPresent(artifact.path),
    })
  }
  return comparisons
}

function flagCountLine(datafile: CodegenDatafile): string {
  const n = datafile.flags.length
  return `${n} flag${n === 1 ? '' : 's'}`
}

// ---------------------------------------------------------------------------
// Mode: --check
// ---------------------------------------------------------------------------

/**
 * Report the comparison and return the exit code. The caller exits, outside
 * its error handler, so "up to date" can never be mistaken for a failure.
 */
async function runCheck(
  artifacts: readonly Artifact[],
  datafile: CodegenDatafile,
  targets: GenerationTargets,
): Promise<ExitCode> {
  const drifts = diffArtifacts(await toComparisons(artifacts))
  const exitCode = drifts.length === 0 ? EXIT.success : EXIT.failure

  if (
    emitJsonResult({
      upToDate: drifts.length === 0,
      checked: artifacts.map((a) => a.path),
      drifted: drifts,
      environment: targets.env,
      flagCount: datafile.flags.length,
      publishedAt: datafile.publishedAt ?? null,
    })
  ) {
    return exitCode
  }

  if (drifts.length === 0) {
    logger.success(describeDriftSummary(drifts))
    logger.dim(`  Checked ${artifacts.length === 1 ? '1 file' : `${artifacts.length} files`} against ${flagCountLine(datafile)} in ${targets.env}.`)
    return exitCode
  }

  logger.error(describeDriftSummary(drifts))
  for (const drift of drifts) {
    for (const line of describeDrift(drift)) logger.errorDetail(line)
  }
  logger.errorDetail('Run the same command without --check, then commit the result.')
  return exitCode
}

// ---------------------------------------------------------------------------
// Mode: --watch
// ---------------------------------------------------------------------------

function reportWatchEvent(event: WatchEvent, targets: GenerationTargets): void {
  switch (event.kind) {
    case 'polled':
      if (event.changed) {
        logger.success(`Updated ${event.written.map((p) => path.relative(process.cwd(), p)).join(', ')}`)
      }
      // An unchanged poll says nothing on purpose: a line every ten seconds
      // buries the one line that matters.
      return
    case 'failed':
      logger.warn(`${event.message} Retrying in ${Math.round(event.retryInMs / 1000)}s.`)
      return
    case 'stopped':
      logger.line()
      logger.dim(`Stopped watching ${targets.env}.`)
  }
}

async function runWatch(
  client: CodegenApiClient,
  targets: GenerationTargets,
  intervalMs: number,
  initialEtag: string | null,
): Promise<void> {
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  logger.dim(
    `Watching ${targets.env} every ${Math.round(intervalMs / 1000)}s. Press Ctrl+C to stop.`,
  )

  const summary = await runWatchLoop<CodegenDatafile>({
    intervalMs,
    initialEtag,
    signal: controller.signal,
    sleep: sleepUntilAborted,
    onEvent: (event) => reportWatchEvent(event, targets),
    fetchDatafile: async (etag) => {
      const result = await client.getDatafileConditional(targets.projectShortId, targets.env, etag)
      return result.status === 'not-modified'
        ? { status: 'not-modified', etag: result.etag }
        : { status: 'ok', datafile: result.body, etag: result.etag }
    },
    writeOutputs: async (datafile) => writeArtifacts(planArtifacts(datafile, targets)),
  })

  if (summary.gaveUp) {
    logger.error(
      `Stopped after ${summary.failures} failed polls. Last error: ${summary.lastError ?? 'unknown'}`,
    )
    process.exit(EXIT.failure)
  }

  process.exit(EXIT.success)
}

/** Wait, but wake up immediately when the user presses Ctrl+C. */
function sleepUntilAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const codegenCommand = withOutputOptions(
  new Command('codegen')
    .description('Generate TypeScript flag types from a datafile, and check them in CI')
    .option('-o, --output <path>', 'output .ts file path', './src/generated/flags.ts')
    .option(
      '-p, --project <project>',
      'project short id (PRJ-42 or 42); defaults to the local .avsb-project.json or .avsb.json',
    )
    .option('-e, --env <environment>', 'environment key', 'production')
    .option('-m, --manifest <path>', 'also write a JSON flag manifest to this path')
    .option(
      '--no-augment',
      'omit the AvsbFlags block, so flag keys stay plain strings (for two AvsB projects in one program)',
    )
    .option('--check', 'do not write: compare with what is on disk and exit non-zero on drift')
    .option('--watch', 'keep generating while the platform changes')
    .option('--interval <seconds>', 'how often --watch polls (2 to 300, default 10)'),
).action(async (opts: CodegenOptions) => {
  beginCommand('codegen', opts)

  if (opts.check && opts.watch) {
    failCommand(
      new CliError('cli_usage', 'Pass --check or --watch, not both.', [
        '--check answers "is this up to date?" once and exits.',
        '--watch keeps it up to date and never exits.',
      ]),
    )
  }

  if (opts.watch && isJsonOutput()) {
    failCommand(
      new CliError('cli_usage', '--watch cannot be combined with --json.', [
        'JSON mode prints exactly one document and exits; --watch never exits.',
        'Unset AVSB_JSON if the environment turned it on.',
      ]),
    )
  }

  const interval = parseWatchInterval(opts.interval)
  if ('error' in interval) {
    failCommand(new CliError('cli_usage', interval.error))
  }
  if (opts.interval !== undefined && !opts.watch) {
    failCommand(
      new CliError('cli_usage', '--interval only means something with --watch.', [
        'Add --watch, or drop --interval.',
      ]),
    )
  }

  // Resolution first: a run inside a cloned folder needs no flag at all, and
  // the source is reported so nobody has to guess which project was read.
  const project = resolveProjectRefOrExit(opts)
  const config = ensureLoggedIn()
  const spinner = startSpinner('Fetching datafile...')
  let checkExitCode: ExitCode | null = null

  try {
    const client = new CodegenApiClient(config)
    const first = await client.getDatafileConditional(project.shortId, opts.env, null)
    if (first.status !== 'ok') {
      // Unreachable: the first read sends no If-None-Match, so 304 is not a
      // legal answer. Refusing beats writing an empty types file from nothing.
      throw new CliError(
        'cli_failed',
        'The platform answered "not modified" to a request that asked for the datafile outright.',
      )
    }
    const datafile = first.body
    spinner.succeed('Datafile fetched')

    const targets: GenerationTargets = {
      typesPath: path.resolve(opts.output),
      manifestPath: opts.manifest ? path.resolve(opts.manifest) : null,
      projectShortId: project.shortId,
      env: opts.env,
      augment: opts.augment !== false,
    }
    const artifacts = planArtifacts(datafile, targets)

    if (opts.check) {
      checkExitCode = await runCheck(artifacts, datafile, targets)
      return
    }

    const written = await writeArtifacts(artifacts)

    if (
      emitJsonResult({
        output: targets.typesPath,
        manifest: targets.manifestPath,
        written,
        augmented: targets.augment,
        projectShortId: project.shortId,
        projectSource: project.source,
        environment: opts.env,
        flagCount: datafile.flags.length,
        publishedAt: datafile.publishedAt ?? null,
      })
    ) {
      if (!opts.watch) return
    } else {
      logger.success(`Wrote ${flagCountLine(datafile)} to ${targets.typesPath}`)
      if (targets.manifestPath) logger.dim(`  Manifest: ${targets.manifestPath}`)
      logger.dim(`  Read ${describeProjectSource(project)}, environment ${opts.env}`)
      if (targets.augment) {
        logger.dim('  Flag keys are now typed. Import the file once from your app to apply it.')
      }
    }

    if (opts.watch) {
      await runWatch(client, targets, interval.ms, first.etag)
    }
  } catch (err) {
    spinner.fail('Codegen failed')
    failCommand(err)
  } finally {
    if (checkExitCode !== null) process.exit(checkExitCode)
  }
})
