/**
 * The side effects of `avsb init`: writing the example file, running the
 * install, and running codegen.
 *
 * Every function here reports what it actually did rather than assuming it
 * worked, because the command's whole promise is that its last line is true.
 *
 * Nothing here decides anything: the plan (see `lib/initPlan.ts`) has already
 * settled which of these run.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
// The emitter, not the command: one definition of what a generated flag file
// looks like, so the file `avsb init --codegen` writes and the file
// `avsb codegen` writes cannot drift.
import { emitTypes } from '../lib/codegenEmit.js'
import { CliError } from '../lib/cliError.js'
import { installArgv, type PackageManager } from '../lib/frameworkDetect.js'
import { buildSample } from '../lib/initSamples.js'
import type { FrameworkProfile } from '../lib/frameworkProfiles.js'
import type { InitApiClient } from '../lib/initApi.js'

export interface ExampleWriteInput {
  dir: string
  profile: FrameworkProfile
  flagKey: string
  sdkKey: string
  environmentKey: string
  /** `--example <path>` overrides the framework's default location. */
  overridePath?: string
}

export interface ExampleWriteResult {
  filePath: string
  wrote: boolean
  /** True when a file was already there, which is never overwritten. */
  existed: boolean
}

/** True when the example file for this profile is already on disk. */
export function exampleFileExists(
  dir: string,
  profile: FrameworkProfile,
  overridePath?: string,
): boolean {
  return fs.existsSync(resolveExamplePath(dir, profile, overridePath))
}

export function resolveExamplePath(
  dir: string,
  profile: FrameworkProfile,
  overridePath?: string,
): string {
  return path.resolve(dir, overridePath ?? profile.exampleFile)
}

/**
 * Write the example, creating any directory it needs.
 *
 * An existing file is never overwritten: it may be the developer's own work,
 * and losing it to a re-run of a setup command would be unforgivable.
 */
export function writeExampleFile(input: ExampleWriteInput): ExampleWriteResult {
  const filePath = resolveExamplePath(input.dir, input.profile, input.overridePath)

  if (fs.existsSync(filePath)) {
    return { filePath, wrote: false, existed: true }
  }

  const contents = buildSample({
    profile: input.profile,
    flagKey: input.flagKey,
    sdkKey: input.sdkKey,
    environmentKey: input.environmentKey,
  })

  if (contents === null) {
    return { filePath, wrote: false, existed: false }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents, 'utf-8')
  return { filePath, wrote: true, existed: false }
}

export interface InstallResult {
  command: string
  ok: boolean
  /** Null when the binary could not be started at all. */
  exitCode: number | null
  detail: string | null
}

/**
 * Run the package manager, inheriting the terminal so its own progress output
 * is what the developer sees.
 *
 * `shell` is on for Windows only: npm, pnpm and yarn are `.cmd` shims there,
 * which `spawnSync` cannot execute directly. Everywhere else the arguments go
 * straight to the binary, so nothing in the package name can reach a shell.
 */
export function runInstall(
  dir: string,
  manager: PackageManager,
  npmPackage: string,
  options: { quiet: boolean },
): InstallResult {
  const { command, args } = installArgv(manager, npmPackage)
  const printable = [command, ...args].join(' ')

  const result = spawnSync(command, args, {
    cwd: dir,
    // A quiet or JSON run must leave stdout carrying only the result, so the
    // package manager's own output is captured and dropped instead of printed.
    stdio: options.quiet ? 'pipe' : 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.error) {
    return {
      command: printable,
      ok: false,
      exitCode: null,
      detail: `Could not run ${command}: ${result.error.message}`,
    }
  }

  const exitCode = result.status ?? 1
  return {
    command: printable,
    ok: exitCode === 0,
    exitCode,
    detail: exitCode === 0 ? null : `${printable} exited with code ${exitCode}`,
  }
}

export interface CodegenRunInput {
  api: InitApiClient
  dir: string
  projectShortId: number
  environmentKey: string
  /** `--codegen-output <path>`, relative to the project. */
  outputPath?: string
}

export interface CodegenRunResult {
  filePath: string
  flagCount: number
}

export const DEFAULT_CODEGEN_OUTPUT = './src/generated/flags.ts'

/**
 * Generate the typed flag file, through the same emitter `avsb codegen` uses.
 *
 * Reusing that function rather than re-implementing it is the point: one
 * definition of what generated flag types look like, so the file init writes and
 * the file the standalone command writes cannot drift.
 */
export async function runCodegen(input: CodegenRunInput): Promise<CodegenRunResult> {
  const datafile = await input.api.getDatafile(input.projectShortId, input.environmentKey)
  const generated = emitTypes(datafile, {
    projectId: String(input.projectShortId),
    env: input.environmentKey,
  })

  const filePath = path.resolve(input.dir, input.outputPath ?? DEFAULT_CODEGEN_OUTPUT)
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, generated, 'utf-8')
  } catch (err) {
    throw new CliError(
      'cli_io_failed',
      `Could not write ${filePath}: ${err instanceof Error ? err.message : 'unknown error'}`,
    )
  }

  return { filePath, flagCount: datafile.flags.length }
}

/** Read a file, or null when it is not there. Never throws. */
export function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/** The file names in a directory, for lockfile detection. Never throws. */
export function listDirectory(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}
