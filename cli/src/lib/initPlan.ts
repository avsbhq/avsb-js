/**
 * What `avsb init` is going to do, decided before it does any of it.
 *
 * The command's shape is "look at the project, decide five things, then carry
 * them out". Splitting the deciding from the carrying-out is what makes the
 * command testable: every branch (a flag that turns a step off, a framework
 * with no environment file, an example file that already exists, a web project
 * with no SDK key at all) is a pure function call with no network, no
 * filesystem and no terminal.
 *
 * The plan is also what `--json` reports, so a script can see which steps ran
 * and which were skipped, and why, without parsing prose.
 */

import { CliError } from './cliError.js'
import type { PackageManager } from './frameworkDetect.js'
import { installCommand } from './frameworkDetect.js'
import type { FrameworkProfile } from './frameworkProfiles.js'
import type { CliProjectType } from '../types/init.js'

export type InitStepId = 'env' | 'install' | 'example' | 'codegen' | 'heartbeat'

export type InitStepAction =
  /** Write a file. */
  | 'write'
  /** Execute something (an install, codegen). */
  | 'run'
  /** Print a command for the developer to run. */
  | 'print'
  /** Poll for the first check-in. */
  | 'wait'
  /** Deliberately not done. `detail` says why. */
  | 'skip'

export interface PlannedStep {
  id: InitStepId
  action: InitStepAction
  /** One line: what will happen, or why it will not. */
  detail: string
}

export interface InitPlanOptions {
  /** False with `--no-env-file`. */
  env: boolean
  /** True with `--install`: run the install rather than printing it. */
  install: boolean
  /** False with `--no-example`. */
  example: boolean
  /** True with `--codegen`, or after an interactive yes. */
  codegen: boolean
  /** False with `--no-wait`. */
  wait: boolean
}

export interface InitPlanInput {
  profile: FrameworkProfile
  packageManager: PackageManager
  projectType: CliProjectType
  /** The environment's SDK key, or null for a web experiments project. */
  sdkKey: string | null
  /** True when the example file is already on disk. */
  exampleExists: boolean
  options: InitPlanOptions
}

/**
 * The three reasons a step can be impossible, kept apart because they are
 * genuinely different situations and a developer deserves the true one.
 *
 * The project TYPE decides the first: a web experiments project has no SDK key
 * to write and no package to install, whatever is in the directory. The
 * DIRECTORY decides the second: a feature flags project set up from a folder
 * with no package.json still gets its key and its check-in, there is just
 * nothing here to install into. The third is defensive.
 */
const WEB_PROJECT_REASON =
  'This is a web experiments project, which installs the snippet tag rather than an SDK key.'

const NO_FRAMEWORK_REASON =
  'No package.json here, so there is no application to install into. Run this in your app directory, or install the SDK yourself.'

const NO_SDK_KEY_REASON =
  'No SDK key resolved for this environment, so there is nothing to write.'

/** True for the pillar that has SDK keys, environments and check-ins. */
function isFlagProject(input: InitPlanInput): boolean {
  return input.projectType === 'FEATURE_FLAG'
}

/** The ordered steps, each already decided. */
export function planInitSteps(input: InitPlanInput): PlannedStep[] {
  return [
    planEnvStep(input),
    planInstallStep(input),
    planExampleStep(input),
    planCodegenStep(input),
    planHeartbeatStep(input),
  ]
}

function planEnvStep(input: InitPlanInput): PlannedStep {
  const { profile, options, sdkKey } = input

  if (!options.env) {
    return { id: 'env', action: 'skip', detail: 'Skipped by --no-env-file.' }
  }
  if (!isFlagProject(input)) {
    return { id: 'env', action: 'skip', detail: WEB_PROJECT_REASON }
  }
  if (sdkKey === null) {
    return { id: 'env', action: 'skip', detail: NO_SDK_KEY_REASON }
  }
  if (!profile.sdkPackage) {
    return { id: 'env', action: 'skip', detail: NO_FRAMEWORK_REASON }
  }
  if (!profile.envFile || !profile.envVar) {
    return {
      id: 'env',
      action: 'skip',
      detail: `${profile.label} has no environment file convention, so the key goes in the example instead.`,
    }
  }

  return {
    id: 'env',
    action: 'write',
    detail: `Write ${profile.envVar} into ${profile.envFile}.`,
  }
}

function planInstallStep(input: InitPlanInput): PlannedStep {
  const { profile, packageManager, options } = input

  if (!isFlagProject(input)) {
    return { id: 'install', action: 'skip', detail: WEB_PROJECT_REASON }
  }
  if (!profile.sdkPackage) {
    return { id: 'install', action: 'skip', detail: NO_FRAMEWORK_REASON }
  }

  const command = installCommand(packageManager, profile.sdkPackage)
  return options.install
    ? { id: 'install', action: 'run', detail: command }
    : {
        id: 'install',
        action: 'print',
        detail: `${command} (pass --install to run it here)`,
      }
}

function planExampleStep(input: InitPlanInput): PlannedStep {
  const { profile, options, exampleExists, sdkKey } = input

  if (!options.example) {
    return { id: 'example', action: 'skip', detail: 'Skipped by --no-example.' }
  }
  if (!isFlagProject(input)) {
    return { id: 'example', action: 'skip', detail: WEB_PROJECT_REASON }
  }
  if (sdkKey === null) {
    return { id: 'example', action: 'skip', detail: NO_SDK_KEY_REASON }
  }
  if (!profile.sdkPackage) {
    return { id: 'example', action: 'skip', detail: NO_FRAMEWORK_REASON }
  }
  if (exampleExists) {
    return {
      id: 'example',
      action: 'skip',
      detail: `${profile.exampleFile} already exists. Left alone.`,
    }
  }

  return { id: 'example', action: 'write', detail: `Write ${profile.exampleFile}.` }
}

function planCodegenStep(input: InitPlanInput): PlannedStep {
  const { options, sdkKey } = input

  if (!isFlagProject(input)) {
    return {
      id: 'codegen',
      action: 'skip',
      detail: 'Typed flags are a feature flags feature, and this is a web experiments project.',
    }
  }
  if (sdkKey === null) {
    return { id: 'codegen', action: 'skip', detail: NO_SDK_KEY_REASON }
  }
  if (!options.codegen) {
    return {
      id: 'codegen',
      action: 'skip',
      detail: 'Not requested. Run `avsb codegen` any time, or pass --codegen.',
    }
  }

  return { id: 'codegen', action: 'run', detail: 'Generate TypeScript types for the flags.' }
}

function planHeartbeatStep(input: InitPlanInput): PlannedStep {
  const { options, sdkKey } = input

  if (!isFlagProject(input)) {
    return {
      id: 'heartbeat',
      action: 'skip',
      detail:
        'A web project proves itself on the first page view instead. The dashboard install panel shows it.',
    }
  }
  if (sdkKey === null) {
    return { id: 'heartbeat', action: 'skip', detail: NO_SDK_KEY_REASON }
  }
  if (!options.wait) {
    return { id: 'heartbeat', action: 'skip', detail: 'Skipped by --no-wait.' }
  }

  return { id: 'heartbeat', action: 'wait', detail: 'Wait for the first check-in from your app.' }
}

/** Find one step in a plan. Keeps the command body free of array scanning. */
export function stepFor(plan: readonly PlannedStep[], id: InitStepId): PlannedStep {
  const found = plan.find((step) => step.id === id)
  if (!found) throw new Error(`No ${id} step in the plan`)
  return found
}

/** Longest wait `--wait` will honour. A terminal held open for a quarter of an
 *  hour is already a failed setup, whatever the flag says. */
export const MAX_WAIT_SECONDS = 900

export const DEFAULT_WAIT_SECONDS = 120

/**
 * `--wait 90` in seconds.
 *
 * Commander gives `true` when only `--no-wait`'s negation default applies and a
 * string when a value was passed, so both shapes arrive here. Nonsense is a
 * usage error rather than a silent fallback: a typo that quietly waits two
 * minutes teaches the wrong thing about the flag.
 */
export function parseWaitSeconds(value: boolean | string | undefined): number {
  if (value === undefined || typeof value === 'boolean') return DEFAULT_WAIT_SECONDS
  const seconds = Number(value.trim())
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError('cli_usage', `--wait takes a number of seconds, not "${value}".`)
  }
  return Math.min(Math.round(seconds), MAX_WAIT_SECONDS)
}

export interface ProofLineInput {
  sdkKey: string
  flagKey: string
  frameworkLabel: string
  elapsedMs: number
}

/** How long the wait took, in the unit that reads naturally at that size. */
export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 1000)}s`
}

/**
 * The last line of a successful run.
 *
 * Two observed facts and nothing more: a check-in newer than this run arrived
 * for that key, and that flag is in the datafile the key serves. It says
 * "checked in and is serving" rather than "evaluated" because evaluation
 * happens inside the developer's process, where the CLI cannot see it; claiming
 * it would be the one sentence in this command that nothing checked. Without
 * both facts the timeout guidance prints instead.
 */
export function buildProofLine(input: ProofLineInput): string {
  return `${input.sdkKey} checked in and is serving '${input.flagKey}' for ${input.frameworkLabel} ${formatElapsed(input.elapsedMs)} after setup`
}

/**
 * Refuse `--require-heartbeat --no-wait`.
 *
 * The pair contradicts itself: one says "fail unless a check-in arrives", the
 * other says "do not look for one". Taken literally the run always fails, with
 * a timeout message about a wait that never happened. A usage error naming both
 * flags is the honest answer, and it lands before anything is written.
 */
export function assertHeartbeatFlagsAgree(input: {
  wait: boolean | string
  requireHeartbeat?: boolean
}): void {
  if (input.requireHeartbeat === true && input.wait === false) {
    throw new CliError(
      'cli_usage',
      '--require-heartbeat cannot be used with --no-wait.',
      [
        'The check-in is what --require-heartbeat waits for, so the two flags cancel out.',
        'Drop --no-wait, or drop --require-heartbeat and read `heartbeat.seen` in the --json output.',
      ],
    )
  }
}

export interface ServedValue {
  /** The variation the environment serves when no rule matches. */
  variationKey: string
  value: unknown
}

/**
 * What the environment serves for a flag when no targeting rule matches.
 *
 * A narrow, checkable reading of the datafile: the default variation for the
 * environment, or nothing when the environment is not serving the flag (in
 * which case an SDK returns the fallback the caller passed). It deliberately
 * does NOT evaluate rules, because rules depend on a context the CLI does not
 * have, and a printed value that a real visitor would not get is worse than no
 * value.
 */
export function servedValueFor(flag: {
  enabled: boolean
  defaultVariationId: string
  variations: Array<{ id: string; key: string; value: unknown }>
}): ServedValue | null {
  if (!flag.enabled) return null
  const variation = flag.variations.find((candidate) => candidate.id === flag.defaultVariationId)
  if (!variation) return null
  return { variationKey: variation.key, value: variation.value }
}

/**
 * How the served value reads in one line, or the honest alternative. An
 * unserved flag names the command that turns it on (QA N4-9): on a new
 * project that is also what gives the SDK a configuration to load.
 */
export function describeServedValue(
  flagKey: string,
  served: ServedValue | null,
  environmentKey = 'production',
): string {
  if (!served) {
    return `${flagKey} is not being served in this environment yet, so your code gets the fallback you pass. Turn it on with \`avsb flags toggle ${flagKey} --env ${environmentKey} --on\`.`
  }
  return `${flagKey} serves ${JSON.stringify(served.value)} (variation ${served.variationKey}) when no targeting rule matches.`
}
