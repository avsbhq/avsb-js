/**
 * `avsb init` — set a project up in the directory you are standing in, and end
 * with proof instead of instructions.
 *
 * One command does what a page of documentation used to: detect the framework
 * from package.json, link or create a project, write the SDK key into the
 * environment file that framework actually reads, name the install command (or
 * run it), write a working example that reads a real flag, optionally generate
 * the types, then wait for the first check-in and say what it saw.
 *
 * Two rules the whole command obeys:
 *
 *   - EVERY PROMPT HAS A FLAG. `--project`, `--create`, `--env`, `--flag`,
 *     `--framework`, `--install`, `--codegen`, `--no-wait`. With `--no-input`,
 *     `--json`, no terminal, or CI set, nothing is asked: the command takes the
 *     documented default or stops and names the flag it needed.
 *   - NOTHING IS OVERWRITTEN. A variable already set is left alone, an existing
 *     example file is left alone, and both are said out loud.
 *
 * The last line is a claim about two observed facts and nothing else: a
 * check-in newer than this run arrived for that key, and that flag is in the
 * datafile the key serves. Without both, the honest timeout guidance prints
 * instead.
 */

import path from 'node:path'
import { Command } from 'commander'
import inquirer from 'inquirer'
import { ensureLoggedIn } from '../lib/config.js'
import { CliError } from '../lib/cliError.js'
import { DEFAULT_CDN_BASE_URL } from '../lib/env.js'
import {
  detectFramework,
  detectPackageManager,
  isFrameworkId,
  parsePackageJson,
  type FrameworkDetection,
  type PackageJsonLike,
} from '../lib/frameworkDetect.js'
import { buildFrameworkProfile } from '../lib/frameworkProfiles.js'
import { heartbeatTimeoutGuidance, type HeartbeatOutcome } from '../lib/heartbeatWait.js'
import { InitApiClient } from '../lib/initApi.js'
import {
  assertHeartbeatFlagsAgree,
  buildProofLine,
  describeServedValue,
  parseWaitSeconds,
  planInitSteps,
  servedValueFor,
} from '../lib/initPlan.js'
import { isInteractiveRun } from '../lib/interactive.js'
import { beginCommand, emitJsonResult, failCommand, withOutputOptions } from '../lib/output.js'
import { startSpinner } from '../lib/outputMode.js'
import { executePlan } from './init.execute.js'
import {
  resolveInitEnvironment,
  resolveInitProject,
  resolveSampleFlag,
  type FlagResolution,
} from './init.project.js'
import { exampleFileExists, listDirectory, readFileOrNull } from './init.write.js'
import { renderInitSummary } from './init.report.js'

export interface InitOptions {
  project?: string
  create?: string
  env: string
  framework?: string
  flag?: string
  dir: string
  install?: boolean
  /** False with `--no-env-file`. */
  envFile: boolean
  /** False with `--no-example`. */
  example: boolean
  examplePath?: string
  codegen?: boolean
  codegenOutput?: string
  /** True by default, false with `--no-wait`, a seconds string with `--wait`. */
  wait: boolean | string
  requireHeartbeat?: boolean
  /** False with `--no-input`. */
  input: boolean
  json?: boolean
  quiet?: boolean
}

export const initCommand = withOutputOptions(
  new Command('init')
    .description('Set this project up: link it, write the SDK key, and prove it works')
    .option('-p, --project <project>', 'Existing project: PRJ-42, 42, or a dashboard URL')
    .option('--create <name>', 'Create a new feature flags project with this name')
    .option('-e, --env <environment>', 'Environment key to set up', 'production')
    .option(
      '--framework <framework>',
      'Override detection: next, nuxt, angular, svelte, vue, solid, react, node, none',
    )
    .option('--flag <key>', 'Flag the example reads (default: the first flag in the project)')
    .option('-d, --dir <path>', 'Project directory to set up', '.')
    .option('--install', 'Run the install command instead of printing it')
    .option('--no-env-file', 'Do not write an environment file')
    .option('--no-example', 'Do not write the example file')
    .option('--example-path <path>', 'Where the example goes, instead of the default')
    .option('--codegen', 'Generate TypeScript flag types as part of setup')
    .option('--codegen-output <path>', 'Where generated types go')
    .option('--wait <seconds>', 'How long to wait for the first check-in (default 120)')
    .option('--no-wait', 'Do not wait for the first check-in')
    .option('--require-heartbeat', 'Exit non-zero when no check-in arrives before the timeout')
    .option('--no-input', 'Never prompt; use flags and defaults only'),
).action(async (opts: InitOptions) => {
  beginCommand('init', opts)

  try {
    const dir = path.resolve(opts.dir ?? '.')
    // Validated here rather than where they are used: a bad `--wait`, or a pair
    // of flags that cancel out, must stop the run before anything is written.
    parseWaitSeconds(opts.wait)
    assertHeartbeatFlagsAgree(opts)
    const interactive = isInteractiveRun({ input: opts.input })
    const pkg = parsePackageJson(readFileOrNull(path.join(dir, 'package.json')) ?? '')
    const detection = resolveDetection(pkg, opts.framework)
    const profile = buildFrameworkProfile(detection)
    const packageManager = detectPackageManager(pkg, listDirectory(dir))

    const session = ensureLoggedIn()
    const api = new InitApiClient(session)

    // No spinner around project resolution: that step may put a prompt on the
    // screen, and a spinner writing over a question is unusable.
    const { project, created } = await resolveInitProject({
      api,
      projectOption: opts.project,
      createName: opts.create,
      interactive,
    })

    const spinner = startSpinner('Reading the project configuration...')
    const environment = await resolveInitEnvironment(api, project, opts.env).finally(() =>
      spinner.stop(),
    )
    const sdkKey = environment?.sdkKey ?? null

    const sample: FlagResolution | null = sdkKey
      ? await resolveSampleFlag(api, project.shortId, opts.env, opts.flag)
      : null

    const codegen = await decideCodegen(opts, interactive, sdkKey !== null)

    const plan = planInitSteps({
      profile,
      packageManager,
      projectType: project.type,
      sdkKey,
      exampleExists: exampleFileExists(dir, profile, opts.examplePath),
      options: {
        env: opts.envFile !== false,
        install: opts.install === true,
        example: opts.example !== false,
        codegen,
        wait: opts.wait !== false,
      },
    })

    const outcome = await executePlan({
      api,
      dir,
      plan,
      profile,
      packageManager,
      project,
      environment,
      flagKey: sample?.flagKey ?? '',
      environmentKey: opts.env,
      examplePath: opts.examplePath,
      codegenOutput: opts.codegenOutput,
      wait: opts.wait,
    })

    const heartbeat = outcome.heartbeat
    const served = sample?.flag ? servedValueFor(sample.flag) : null
    const proof =
      heartbeat?.seen && sample?.flag && sdkKey
        ? buildProofLine({
            sdkKey,
            flagKey: sample.flagKey,
            frameworkLabel: profile.label,
            elapsedMs: heartbeat.elapsedMs,
          })
        : null

    // Decided before anything is printed: the JSON contract is exactly one
    // document per run, so a required-but-missing check-in has to fail here
    // rather than after a success envelope has already gone out.
    if (opts.requireHeartbeat && !heartbeat?.seen) {
      failCommand(
        new CliError('cli_failed', 'No check-in arrived before the timeout.', [
          'Setup finished. Only the proof is missing: start your app, then run `avsb init` again.',
        ]),
      )
    }

    if (
      emitJsonResult({
        project: {
          shortId: project.shortId,
          name: project.name,
          type: project.type,
          created,
        },
        environment: environment
          ? { key: environment.key, name: environment.name, sdkKey: environment.sdkKey }
          : null,
        framework: {
          id: profile.id,
          label: profile.label,
          detectedFrom: detection.matchedDependency,
          packageManager,
          bundler: detection.bundler?.id ?? null,
          envVar: profile.envVar,
        },
        flag: sample ? { key: sample.flagKey, exists: sample.flag !== null, served } : null,
        steps: plan,
        files: outcome.files,
        install: outcome.install,
        heartbeat: describeHeartbeatForJson(heartbeat),
        proof,
      })
    ) {
      return
    }

    renderInitSummary({
      project,
      created,
      environment,
      profile,
      detection,
      packageManager,
      plan,
      files: outcome.files,
      install: outcome.install,
      flagKey: sample?.flagKey ?? null,
      flagExists: sample !== null && sample.flag !== null,
      servedLine: sample?.flag ? describeServedValue(sample.flagKey, served, opts.env) : null,
      heartbeat,
      proof,
      timeoutGuidance:
        heartbeat && !heartbeat.seen && environment
          ? heartbeatTimeoutGuidance({
              sdkKey: environment.sdkKey,
              environmentName: environment.name,
              environmentKey: environment.key,
              flagKey: sample?.flagKey ?? null,
              previousSeenAt: heartbeat.previousSeenAt,
              waitedMs: heartbeat.elapsedMs,
              cdnHost: new URL(DEFAULT_CDN_BASE_URL).host,
              appHost: new URL(session.apiBaseUrl).host,
            })
          : [],
    })
  } catch (err) {
    failCommand(err)
  }
})

/** The heartbeat block in the JSON envelope. Always present, so a script can
 *  read `heartbeat.seen` without checking whether the key exists. */
export function describeHeartbeatForJson(outcome: HeartbeatOutcome | null): {
  waited: boolean
  seen: boolean
  at: string | null
  sdkType: string | null
  elapsedMs: number
} {
  if (!outcome) return { waited: false, seen: false, at: null, sdkType: null, elapsedMs: 0 }
  if (outcome.seen) {
    return {
      waited: true,
      seen: true,
      at: outcome.at,
      sdkType: outcome.sdkType,
      elapsedMs: outcome.elapsedMs,
    }
  }
  return { waited: true, seen: false, at: null, sdkType: null, elapsedMs: outcome.elapsedMs }
}

/** Detection, with `--framework` as the override. */
export function resolveDetection(
  pkg: PackageJsonLike | null,
  override: string | undefined,
): FrameworkDetection {
  const detected = detectFramework(pkg)
  if (override === undefined) return detected

  const requested = override.trim().toLowerCase()
  if (!isFrameworkId(requested)) {
    throw new CliError('cli_usage', `Unknown framework "${override}".`, [
      'Known values: next, nuxt, angular, svelte, vue, solid, react, node, none.',
    ])
  }

  return { ...detected, id: requested, matchedDependency: null }
}

/** Codegen runs when asked for, or after a yes. Never silently. */
async function decideCodegen(
  opts: InitOptions,
  interactive: boolean,
  hasSdkKey: boolean,
): Promise<boolean> {
  if (opts.codegen === true) return true
  if (!hasSdkKey || !interactive) return false

  const { generate } = await inquirer.prompt<{ generate: boolean }>([
    {
      type: 'confirm',
      name: 'generate',
      message: 'Generate TypeScript types for your flags now?',
      default: true,
    },
  ])
  return generate
}
