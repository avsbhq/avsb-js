/**
 * Carrying out an `avsb init` plan.
 *
 * The plan (pure, in `lib/initPlan.ts`) has already decided which steps run.
 * This file does them and records what each one actually did, so both the human
 * summary and the `--json` envelope describe the run rather than the intention.
 */

import { installCommand, type PackageManager } from '../lib/frameworkDetect.js'
import type { FrameworkProfile } from '../lib/frameworkProfiles.js'
import { describeEnvWrite, writeEnvAssignment, type EnvWriteOutcome } from '../lib/envFile.js'
import { ensureGitignored } from '../lib/gitignore.js'
import { waitForHeartbeat, type HeartbeatOutcome } from '../lib/heartbeatWait.js'
import type { InitApiClient } from '../lib/initApi.js'
import { parseWaitSeconds, stepFor, type PlannedStep } from '../lib/initPlan.js'
import * as logger from '../lib/logger.js'
import { isQuiet, startSpinner } from '../lib/outputMode.js'
import { runCodegen, runInstall, writeExampleFile } from './init.write.js'
import type { CliFlagEnvironment, CliPublicProject } from '../types/init.js'

export interface InitFiles {
  /** Absolute path of the environment file, when one was touched. */
  env: string | null
  envOutcome: EnvWriteOutcome | null
  example: string | null
  codegen: string | null
  /** The `.gitignore` that gained the environment file, when one did. */
  gitignore: string | null
}

export interface InitInstallReport {
  command: string
  /** True when `--install` ran it here. */
  ran: boolean
  /** Meaningful only when `ran` is true. */
  ok: boolean
}

export interface ExecuteResult {
  files: InitFiles
  install: InitInstallReport | null
  /** Null when the plan skipped the wait. */
  heartbeat: HeartbeatOutcome | null
}

export interface ExecuteInput {
  api: InitApiClient
  dir: string
  plan: readonly PlannedStep[]
  profile: FrameworkProfile
  packageManager: PackageManager
  project: CliPublicProject
  environment: CliFlagEnvironment | null
  flagKey: string
  environmentKey: string
  examplePath?: string
  codegenOutput?: string
  wait: boolean | string
}

export async function executePlan(input: ExecuteInput): Promise<ExecuteResult> {
  const files: InitFiles = { env: null, envOutcome: null, example: null, codegen: null, gitignore: null }
  let install: InitInstallReport | null = null

  const { profile, environment } = input

  if (stepFor(input.plan, 'env').action === 'write' && environment && profile.envFile && profile.envVar) {
    const result = writeEnvAssignment({
      dir: input.dir,
      file: profile.envFile,
      name: profile.envVar,
      value: environment.sdkKey,
    })
    files.env = result.filePath
    files.envOutcome = result.outcome
    logger.info(describeEnvWrite(result, profile.envVar))

    // Whatever happened to the file, it exists now: keep it out of git.
    const ignored = ensureGitignored(input.dir, profile.envFile)
    if (ignored.outcome === 'added' && ignored.gitignorePath) {
      files.gitignore = ignored.gitignorePath
      logger.info(`Added ${profile.envFile} to ${ignored.gitignorePath}, so git does not pick it up`)
    }
  }

  const installStep = stepFor(input.plan, 'install')
  if (profile.sdkPackage) {
    const command = installCommand(input.packageManager, profile.sdkPackage)
    if (installStep.action === 'run') {
      const result = runInstall(input.dir, input.packageManager, profile.sdkPackage, {
        quiet: isQuiet(),
      })
      install = { command: result.command, ran: true, ok: result.ok }
      if (!result.ok && result.detail) logger.warn(result.detail)
    } else if (installStep.action === 'print') {
      install = { command, ran: false, ok: false }
    }
  }

  if (stepFor(input.plan, 'example').action === 'write' && environment) {
    const result = writeExampleFile({
      dir: input.dir,
      profile,
      flagKey: input.flagKey,
      sdkKey: environment.sdkKey,
      environmentKey: input.environmentKey,
      overridePath: input.examplePath,
    })
    if (result.wrote) files.example = result.filePath
  }

  if (stepFor(input.plan, 'codegen').action === 'run') {
    const result = await runCodegen({
      api: input.api,
      dir: input.dir,
      projectShortId: input.project.shortId,
      environmentKey: input.environmentKey,
      outputPath: input.codegenOutput,
    })
    files.codegen = result.filePath
    logger.info(`Wrote ${result.flagCount} flag types to ${result.filePath}`)
  }

  let heartbeat: HeartbeatOutcome | null = null
  if (stepFor(input.plan, 'heartbeat').action === 'wait' && environment) {
    heartbeat = await watchForCheckIn(input.api, input.project.shortId, environment, input.wait)
  }

  return { files, install, heartbeat }
}

/**
 * Poll the environments API until this environment reports a check-in newer
 * than now, or the window closes. The spinner says what the developer is meant
 * to be doing while it waits.
 */
export async function watchForCheckIn(
  api: InitApiClient,
  projectShortId: number,
  environment: CliFlagEnvironment,
  wait: boolean | string,
): Promise<HeartbeatOutcome> {
  const seconds = parseWaitSeconds(wait)
  const spinner = startSpinner(
    `Waiting for the first check-in from ${environment.name}. Start your app now.`,
  )

  const outcome = await waitForHeartbeat({
    startedAt: Date.now(),
    timeoutMs: seconds * 1000,
    probe: async () => {
      const response = await api.listEnvironments(projectShortId)
      const row = response.data.find((candidate) => candidate.id === environment.id)
      return {
        lastSdkSeenAt: row?.lastSdkSeenAt ?? null,
        lastSdkType: row?.lastSdkType ?? null,
        lastSdkVersion: row?.lastSdkVersion ?? null,
      }
    },
  })

  if (outcome.seen) spinner.succeed('Check-in received')
  else spinner.warn('No check-in yet')

  return outcome
}
