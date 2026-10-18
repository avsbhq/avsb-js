/**
 * Writing a pulled project script to disk, and keeping it in step.
 *
 * Like the experiment scaffold, the TypeScript declarations come from the
 * published `@avsbhq/snippet-types` package rather than a copy kept here.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ApiProjectResponse, ProjectManifest } from '../types/project.js'
import { CliError } from './cliError.js'
import { failCommand } from './output.js'
import { refreshTypeDefinitions, writeTypeDefinitions } from './scaffold.js'
import { SNIPPET_TYPE_DEF_FILES } from './snippetTypeDefs.js'

const PROJECT_MANIFEST_FILENAME = '.avsb-project.json'

const PROJECT_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2017',
      lib: ['ES2017', 'DOM', 'DOM.Iterable'],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      moduleResolution: 'bundler',
    },
    include: ['**/*.ts', ...SNIPPET_TYPE_DEF_FILES],
    exclude: ['node_modules'],
  },
  null,
  2
)

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function parseProjectInput(input: string): number {
  const urlMatch = input.match(/projects\/(\d+)/)
  if (urlMatch) return parseInt(urlMatch[1], 10)

  const prefixed = input.replace(/^PRJ-/i, '')
  const num = parseInt(prefixed, 10)
  if (Number.isNaN(num)) {
    throw new Error(`Cannot parse project ID from: ${input}`)
  }
  return num
}

export function writeProjectManifest(dir: string, manifest: ProjectManifest): void {
  const manifestPath = path.join(dir, PROJECT_MANIFEST_FILENAME)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}

export function readProjectManifest(dir: string): ProjectManifest | null {
  const manifestPath = path.join(dir, PROJECT_MANIFEST_FILENAME)
  if (!fs.existsSync(manifestPath)) return null
  const raw = fs.readFileSync(manifestPath, 'utf-8')
  return JSON.parse(raw) as ProjectManifest
}

export function findProjectManifestDir(startDir?: string): string | null {
  let dir = startDir ?? process.cwd()

  for (let i = 0; i < 10; i++) {
    const manifestPath = path.join(dir, PROJECT_MANIFEST_FILENAME)
    if (fs.existsSync(manifestPath)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

export function readProjectManifestOrExit(startDir?: string): { manifest: ProjectManifest; dir: string } {
  const dir = findProjectManifestDir(startDir)
  if (!dir) {
    failCommand(
      new CliError(
        'cli_no_manifest',
        'No .avsb-project.json found in this folder or above it.',
        ['Run `avsb project pull <id>` first, or change into the folder it created.'],
      ),
    )
  }
  const manifest = readProjectManifest(dir)!
  return { manifest, dir }
}

export type ProjectPullTarget =
  /** A folder that already holds this project: re-pull in place. */
  | { kind: 'existing'; dir: string }
  /** Nothing there yet: scaffold `project-<id>/` here. */
  | { kind: 'fresh'; dir: string }
  /** `project-<id>/` exists but is not a pulled project folder. */
  | { kind: 'blocked'; dir: string }

/**
 * Where `avsb project pull <id>` should write.
 *
 * Run from inside the project's own folder, it used to scaffold a nested
 * `project-<id>/project-<id>/`, and a later `--force` then compared against
 * that copy and reported "Already up to date" while the real file kept its
 * edits (QA N4-18). The folder you are in, or one above it, that already
 * holds this project wins; then `project-<id>/` beside you; then a fresh one.
 */
export function resolveProjectPullTarget(cwd: string, shortId: number): ProjectPullTarget {
  const enclosing = findProjectManifestDir(cwd)
  if (enclosing && readProjectManifest(enclosing)?.projectShortId === shortId) {
    return { kind: 'existing', dir: enclosing }
  }

  const beside = path.join(cwd, `project-${shortId}`)
  if (!fs.existsSync(beside)) return { kind: 'fresh', dir: beside }
  return readProjectManifest(beside)?.projectShortId === shortId
    ? { kind: 'existing', dir: beside }
    : { kind: 'blocked', dir: beside }
}

interface ScaffoldProjectOptions {
  data: ApiProjectResponse['data']
  apiBaseUrl: string
  targetDir?: string
}

export function scaffoldProject(options: ScaffoldProjectOptions): { dir: string; files: string[] } {
  const { data, apiBaseUrl, targetDir } = options
  const { project } = data

  const lang: 'js' | 'ts' = project.projectJsLang === 'TYPESCRIPT' ? 'ts' : 'js'
  const folderName = `project-${project.shortId}`
  const baseDir = targetDir ?? path.join(process.cwd(), folderName)

  if (fs.existsSync(baseDir)) {
    throw new Error(`Directory already exists: ${baseDir}`)
  }

  fs.mkdirSync(baseDir, { recursive: true })

  const files: string[] = []

  const scriptFile = `project.${lang}`
  const content = lang === 'ts'
    ? (project.editorProjectTs ?? project.editorProjectJs ?? '')
    : (project.editorProjectJs ?? '')
  fs.writeFileSync(path.join(baseDir, scriptFile), content)
  files.push(scriptFile)

  const manifest: ProjectManifest = {
    version: 1,
    projectId: project.id,
    projectShortId: project.shortId,
    projectName: project.name,
    orgId: project.org.id,
    snippetKey: project.snippetKey,
    language: lang,
    lastSyncedAt: new Date().toISOString(),
    platformUrl: `${apiBaseUrl}/projects/${project.shortId}/settings?tab=snippet`,
    syncedHash: content ? sha256(content) : undefined,
  }
  writeProjectManifest(baseDir, manifest)
  files.push('.avsb-project.json')

  if (lang === 'ts') {
    fs.writeFileSync(path.join(baseDir, 'tsconfig.json'), PROJECT_TSCONFIG)
    files.push('tsconfig.json')
    files.push(...writeTypeDefinitions(baseDir))
  }

  return { dir: baseDir, files }
}

export function updateProjectFile(
  dir: string,
  manifest: ProjectManifest,
  data: ApiProjectResponse['data']
): string[] {
  const { project } = data
  const updated: string[] = []

  // Refresh the declarations too, so a folder pulled long ago picks up the APIs
  // the snippet has shipped since.
  updated.push(...refreshTypeDefinitions(dir, manifest.language))

  const scriptFile = `project.${manifest.language}`
  const scriptPath = path.join(dir, scriptFile)
  const current = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf-8') : ''
  const remote = manifest.language === 'ts'
    ? (project.editorProjectTs ?? project.editorProjectJs ?? '')
    : (project.editorProjectJs ?? '')

  if (current !== remote) {
    fs.writeFileSync(scriptPath, remote)
    updated.push(scriptFile)
  }

  manifest.lastSyncedAt = new Date().toISOString()
  manifest.syncedHash = remote ? sha256(remote) : undefined
  writeProjectManifest(dir, manifest)

  return updated
}
