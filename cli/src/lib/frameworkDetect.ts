/**
 * Reading a developer's `package.json` and answering two questions:
 * which framework is this, and which package manager installs into it.
 *
 * Detection is deliberately shallow. It looks at declared dependencies and
 * lockfiles, never at source files, because the answer only decides which
 * install line, which environment variable name, and which example file
 * `avsb init` offers. A wrong guess costs the developer one flag
 * (`--framework`), so guessing beats interrogating their repository.
 *
 * Order matters where frameworks nest: Nuxt declares Vue, Next declares React,
 * and SvelteKit declares Svelte, so the outer one is checked first.
 *
 * Everything here is pure: `package.json` arrives as text, the directory
 * arrives as a list of file names.
 */

export type FrameworkId =
  | 'next'
  | 'nuxt'
  | 'angular'
  | 'svelte'
  | 'vue'
  | 'solid'
  | 'react'
  | 'node'
  /** No package.json at all: a site rather than an application. */
  | 'none'

export const FRAMEWORK_IDS: readonly FrameworkId[] = [
  'next',
  'nuxt',
  'angular',
  'svelte',
  'vue',
  'solid',
  'react',
  'node',
  'none',
]

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface PackageJsonLike {
  name?: string
  packageManager?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * The browser build tools whose environment-variable convention is known. The
 * bundler, not the framework, decides which variables reach browser code:
 * Vite exposes `VITE_`, Create React App `REACT_APP_`, Vue CLI `VUE_APP_`.
 */
export type BundlerId = 'vite' | 'create-react-app' | 'vue-cli'

export interface BundlerDetection {
  id: BundlerId
  /** The dependency that gave it away, so the CLI can say why. */
  dependency: string
}

export interface FrameworkDetection {
  id: FrameworkId
  /** The dependency that decided it, so the CLI can say why. */
  matchedDependency: string | null
  /** Vite is what decides the browser environment-variable prefix. */
  usesVite: boolean
  usesSvelteKit: boolean
  /** The browser bundler, when it is one whose variable prefix is known. */
  bundler: BundlerDetection | null
}

const BUNDLERS: Array<{ id: BundlerId; dependency: string }> = [
  { id: 'vite', dependency: 'vite' },
  { id: 'create-react-app', dependency: 'react-scripts' },
  { id: 'vue-cli', dependency: '@vue/cli-service' },
]

/** The first known bundler in the dependencies, Vite first. */
export function detectBundler(deps: Record<string, string>): BundlerDetection | null {
  for (const bundler of BUNDLERS) {
    if (Object.prototype.hasOwnProperty.call(deps, bundler.dependency)) return bundler
  }
  return null
}

/**
 * Parse a `package.json`. Returns null for anything that is not a JSON object,
 * so a malformed file degrades to "no framework detected" instead of throwing
 * in the middle of setup.
 */
export function parsePackageJson(raw: string): PackageJsonLike | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const record = parsed as Record<string, unknown>
  const result: PackageJsonLike = {}
  if (typeof record.name === 'string') result.name = record.name
  if (typeof record.packageManager === 'string') result.packageManager = record.packageManager
  const deps = readDependencyMap(record.dependencies)
  if (deps) result.dependencies = deps
  const devDeps = readDependencyMap(record.devDependencies)
  if (devDeps) result.devDependencies = devDeps
  return result
}

function readDependencyMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
    if (typeof version === 'string') out[name] = version
  }
  return out
}

/** Dependencies and devDependencies as one lookup. */
export function allDependencies(pkg: PackageJsonLike | null): Record<string, string> {
  if (!pkg) return {}
  return { ...pkg.devDependencies, ...pkg.dependencies }
}

/**
 * Which framework this project uses.
 *
 * `node` is the answer for a package.json with none of the front-end frameworks
 * in it: a server, a worker, a CLI. `none` means there is no package.json,
 * which is the web-snippet path rather than an SDK path.
 */
export function detectFramework(pkg: PackageJsonLike | null): FrameworkDetection {
  if (!pkg) {
    return { id: 'none', matchedDependency: null, usesVite: false, usesSvelteKit: false, bundler: null }
  }

  const deps = allDependencies(pkg)
  const has = (name: string): boolean => Object.prototype.hasOwnProperty.call(deps, name)
  const usesVite = has('vite')
  const usesSvelteKit = has('@sveltejs/kit')
  const bundler = detectBundler(deps)

  const ordered: Array<{ id: FrameworkId; dependency: string }> = [
    { id: 'nuxt', dependency: 'nuxt' },
    { id: 'next', dependency: 'next' },
    { id: 'angular', dependency: '@angular/core' },
    { id: 'svelte', dependency: '@sveltejs/kit' },
    { id: 'svelte', dependency: 'svelte' },
    { id: 'solid', dependency: 'solid-js' },
    { id: 'vue', dependency: 'vue' },
    { id: 'react', dependency: 'react' },
  ]

  for (const candidate of ordered) {
    if (has(candidate.dependency)) {
      return {
        id: candidate.id,
        matchedDependency: candidate.dependency,
        usesVite,
        usesSvelteKit,
        bundler,
      }
    }
  }

  return { id: 'node', matchedDependency: null, usesVite, usesSvelteKit, bundler }
}

/** True when the string names a framework the CLI knows. For `--framework`. */
export function isFrameworkId(value: string): value is FrameworkId {
  return (FRAMEWORK_IDS as readonly string[]).includes(value)
}

const LOCKFILES: Array<{ file: string; manager: PackageManager }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm' },
  { file: 'bun.lockb', manager: 'bun' },
  { file: 'bun.lock', manager: 'bun' },
  { file: 'yarn.lock', manager: 'yarn' },
  { file: 'package-lock.json', manager: 'npm' },
]

/**
 * Which package manager to suggest.
 *
 * The `packageManager` field wins when present (it is the declared answer, and
 * corepack enforces it), then the lockfile on disk, then npm.
 */
export function detectPackageManager(
  pkg: PackageJsonLike | null,
  files: readonly string[],
): PackageManager {
  const declared = pkg?.packageManager?.split('@')[0]?.trim().toLowerCase()
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'bun' || declared === 'npm') {
    return declared
  }

  for (const lockfile of LOCKFILES) {
    if (files.includes(lockfile.file)) return lockfile.manager
  }

  return 'npm'
}

/** The install command for a package, in the detected manager's grammar. */
export function installCommand(manager: PackageManager, npmPackage: string): string {
  switch (manager) {
    case 'npm':
      return `npm install ${npmPackage}`
    case 'pnpm':
      return `pnpm add ${npmPackage}`
    case 'yarn':
      return `yarn add ${npmPackage}`
    case 'bun':
      return `bun add ${npmPackage}`
  }
}

/** Split for `spawn`: the binary and its arguments, never a shell string. */
export function installArgv(
  manager: PackageManager,
  npmPackage: string,
): { command: string; args: string[] } {
  switch (manager) {
    case 'npm':
      return { command: 'npm', args: ['install', npmPackage] }
    case 'pnpm':
      return { command: 'pnpm', args: ['add', npmPackage] }
    case 'yarn':
      return { command: 'yarn', args: ['add', npmPackage] }
    case 'bun':
      return { command: 'bun', args: ['add', npmPackage] }
  }
}
