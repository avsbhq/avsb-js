/**
 * What `avsb init` prints when it is not printing JSON.
 *
 * Kept apart from the command body so the wording is in one readable place, and
 * so the ordering rule is easy to hold: facts about what happened first, then
 * what is left to do, then either the proof line or the honest reason there is
 * none.
 */

import { ASSISTANT_PROMPT_INTRO, buildAssistantPrompt } from '../lib/assistantPrompt.js'
import type { FrameworkDetection, PackageManager } from '../lib/frameworkDetect.js'
import type { FrameworkProfile } from '../lib/frameworkProfiles.js'
import type { HeartbeatOutcome } from '../lib/heartbeatWait.js'
import type { PlannedStep } from '../lib/initPlan.js'
import * as logger from '../lib/logger.js'
import type { InitFiles, InitInstallReport } from './init.execute.js'
import type { CliFlagEnvironment, CliPublicProject } from '../types/init.js'

export interface InitSummaryInput {
  project: CliPublicProject
  created: boolean
  environment: CliFlagEnvironment | null
  profile: FrameworkProfile
  detection: FrameworkDetection
  packageManager: PackageManager
  plan: readonly PlannedStep[]
  files: InitFiles
  install: InitInstallReport | null
  flagKey: string | null
  flagExists: boolean
  /** One line about what the environment serves, when a flag was read. */
  servedLine: string | null
  heartbeat: HeartbeatOutcome | null
  proof: string | null
  timeoutGuidance: readonly string[]
}

export function renderInitSummary(input: InitSummaryInput): void {
  logger.line()
  logger.heading(input.created ? 'Project created' : 'Project linked')
  logger.label('Project', `${input.project.name} (PRJ-${input.project.shortId})`)
  if (input.environment) {
    logger.label('Environment', `${input.environment.name} (${input.environment.key})`)
    logger.label('SDK key', input.environment.sdkKey)
  }
  logger.label('Framework', describeDetection(input))
  logger.line()

  renderSteps(input)
  renderWhatIsLeft(input)
  renderAssistantPrompt(input)
  renderProof(input)
}

/**
 * The framework line, including why the SDK key variable has its name when a
 * bundler decided it (QA N4-17), so a REACT_APP_ or VITE_ prefix is never a
 * mystery.
 */
export function describeDetection(input: Pick<InitSummaryInput, 'detection' | 'profile' | 'packageManager'>): string {
  const manager = `installs with ${input.packageManager}`
  const variable =
    input.profile.envVar && input.profile.envVarReason
      ? `, key in ${input.profile.envVar}: ${input.profile.envVarReason}`
      : ''
  if (input.detection.matchedDependency) {
    return `${input.profile.label} (found ${input.detection.matchedDependency} in package.json${variable}, ${manager})`
  }
  if (input.profile.id === 'none') {
    return 'no package.json found here'
  }
  return `${input.profile.label} (${manager})`
}

/**
 * Which files this run wrote, and which it found and left alone. The
 * environment file belongs in "Written" only when bytes went in: on a second
 * run the line above it said "Left alone" while this list said "Written"
 * (QA N4-16).
 */
export function fileReport(files: InitFiles): { written: string[]; leftAlone: string[] } {
  const envWritten = files.envOutcome === 'created' || files.envOutcome === 'appended'
  const written = [envWritten ? files.env : null, files.example, files.codegen, files.gitignore].filter(
    (file): file is string => file !== null,
  )
  const leftAlone = !envWritten && files.env !== null ? [files.env] : []
  return { written, leftAlone }
}

function renderSteps(input: InitSummaryInput): void {
  const { written, leftAlone } = fileReport(input.files)

  if (written.length > 0) {
    logger.heading('Written')
    logger.fileTree(written)
    logger.line()
  }

  if (leftAlone.length > 0) {
    logger.heading('Left alone')
    logger.fileTree(leftAlone)
    logger.line()
  }

  // Skipped steps are printed too: a step that quietly did nothing is the one
  // thing a setup command must never do.
  const skipped = input.plan.filter((step) => step.action === 'skip')
  for (const step of skipped) logger.dim(`  Skipped ${step.id}: ${step.detail}`)
  if (skipped.length > 0) logger.line()
}

function renderWhatIsLeft(input: InitSummaryInput): void {
  const todo = whatIsLeftLines(input)
  if (todo.length === 0) return

  logger.line()
  logger.heading('Next')
  for (const line of todo) logger.dim(`  ${line}`)
}

/** The "Next" list: what the developer still has to do, in order. Pure, for the tests. */
export function whatIsLeftLines(input: InitSummaryInput): string[] {
  const todo: string[] = []

  if (input.install && !input.install.ran) {
    todo.push(`Install the SDK: ${input.install.command}`)
  }
  if (input.install && input.install.ran && !input.install.ok) {
    todo.push(`The install did not finish. Run it again: ${input.install.command}`)
  }
  if (input.profile.caveat) {
    todo.push(input.profile.caveat)
  }
  if (input.flagKey && !input.flagExists) {
    const envKey = input.environment?.key ?? 'production'
    todo.push(
      `The example reads "${input.flagKey}", which does not exist yet. Create it with \`avsb flags create ${input.flagKey}\`, then turn it on with \`avsb flags toggle ${input.flagKey} --env ${envKey} --on\`.`,
    )
  }
  if (input.servedLine) {
    todo.push(input.servedLine)
  }

  return todo
}

function renderAssistantPrompt(input: InitSummaryInput): void {
  if (!input.environment && input.project.type === 'FEATURE_FLAG') return

  const prompt = buildAssistantPrompt({
    projectType: input.project.type,
    frameworkLabel: input.profile.label,
    sdkPackage: input.profile.sdkPackage,
    sdkKeyEnvVar: input.profile.envVar,
    envFile: input.profile.envFile,
    sdkKey: input.environment?.sdkKey ?? null,
    projectShortId: input.project.shortId,
    environmentKey: input.environment?.key ?? 'production',
    flagKey: input.flagKey,
  })

  logger.line()
  logger.heading('Hand the rest to your assistant')
  logger.dim(`  ${ASSISTANT_PROMPT_INTRO}`)
  logger.line()
  for (const line of prompt.split('\n')) logger.dim(`  ${line}`)
}

function renderProof(input: InitSummaryInput): void {
  logger.line()

  // `logger.line`, not `logger.success`: the proof IS the result of this
  // command, and a `--quiet` run prints the result. Decoration is what quiet
  // mode drops, not the outcome.
  if (input.proof) {
    logger.line(input.proof)
    if (input.heartbeat?.seen && input.heartbeat.sdkType) {
      logger.dim(`  Checked in from ${input.heartbeat.sdkType} at ${input.heartbeat.at}`)
    }
    return
  }

  if (input.heartbeat?.seen) {
    logger.line(
      `Your app checked in at ${input.heartbeat.at}. The SDK key works and the configuration reached it.`,
    )
    return
  }

  if (input.timeoutGuidance.length > 0) {
    logger.warn(input.timeoutGuidance[0])
    for (const line of input.timeoutGuidance.slice(1)) logger.errorDetail(line)
    return
  }

  if (input.project.type !== 'FEATURE_FLAG') {
    logger.info(
      'Web experiments install with the snippet tag. Run `avsb open snippet` for the exact tag for this project.',
    )
  }
}
