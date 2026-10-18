/**
 * Writing a cloned experiment to disk, and keeping it in step with the platform.
 *
 * The TypeScript declarations a scaffold drops in come from the published
 * `@avsbhq/snippet-types` package (see `snippetTypeDefs.ts`), not from a copy
 * kept here: this file used to carry its own hand-written `avsb.d.ts`, and it
 * had drifted several APIs behind the runtime.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AvsbManifest, ApiExperimentResponse, ManifestVariation } from '../types/experiment.js'
import { computeSyncHashes, toKebabCase, variationFolderName, writeManifest } from './manifest.js'
import { readSnippetTypeDefs, SNIPPET_TYPE_DEF_FILES } from './snippetTypeDefs.js'
import * as logger from './logger.js'

const TSCONFIG_TEMPLATE = JSON.stringify(
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

/**
 * Write the published `window.avsb` and authoring declarations into a folder,
 * returning the filenames written.
 *
 * A missing copy is loud but not fatal: the experiment files are already on disk
 * and are worth more than the type hints, so the scaffold says what went wrong
 * and keeps everything else it wrote.
 */
export function writeTypeDefinitions(dir: string): string[] {
  try {
    const written: string[] = []
    for (const file of readSnippetTypeDefs()) {
      fs.writeFileSync(path.join(dir, file.filename), file.contents)
      written.push(file.filename)
    }
    return written
  } catch (err) {
    logger.warn(
      err instanceof Error
        ? `Type definitions were not written: ${err.message}`
        : 'Type definitions were not written.',
    )
    logger.warn('Everything else was written. Editor hints for `avsb` will be missing.')
    return []
  }
}

interface ScaffoldOptions {
  data: ApiExperimentResponse['data']
  script: 'js' | 'ts'
  style: 'css' | 'scss'
  apiBaseUrl: string
  targetDir?: string
}

export function scaffoldExperiment(options: ScaffoldOptions): { dir: string; files: string[] } {
  const { data, script, style, apiBaseUrl, targetDir } = options
  const { experiment, project, org } = data

  const folderName = toKebabCase(experiment.name)
  const baseDir = targetDir ?? path.join(process.cwd(), folderName)

  if (fs.existsSync(baseDir)) {
    throw new Error(`Directory already exists: ${baseDir}`)
  }

  fs.mkdirSync(baseDir, { recursive: true })

  const files: string[] = []
  const manifestVariations: ManifestVariation[] = []

  const triggerFile = `trigger.${script}`
  fs.writeFileSync(path.join(baseDir, triggerFile), experiment.triggersJs)
  files.push(triggerFile)

  for (const variation of experiment.variations) {
    const folder = variationFolderName(variation.name)
    const varDir = path.join(baseDir, folder)
    fs.mkdirSync(varDir, { recursive: true })

    const scriptFile = `${folder}.${script}`
    const styleFile = `${folder}.${style}`

    fs.writeFileSync(path.join(varDir, scriptFile), variation.controlJs)
    fs.writeFileSync(path.join(varDir, styleFile), variation.controlCss)

    files.push(`${folder}/${scriptFile}`)
    files.push(`${folder}/${styleFile}`)

    manifestVariations.push({
      id: variation.id,
      shortId: variation.shortId,
      name: variation.name,
      type: variation.type,
      weight: variation.weight,
      folder,
      scriptFile,
      styleFile,
    })
  }

  const manifest: AvsbManifest = {
    version: 1,
    experimentId: experiment.id,
    experimentShortId: experiment.shortId,
    experimentName: experiment.name,
    projectId: project.id,
    projectShortId: project.shortId,
    orgId: org.id,
    snippetKey: project.snippetKey,
    status: experiment.status,
    languages: { script, style },
    trafficAlloc: experiment.trafficAlloc,
    targetingRules: experiment.targetingRules,
    variations: manifestVariations,
    allowedVariations: [],
    lastSyncedAt: new Date().toISOString(),
    platformUrl: `${apiBaseUrl}/projects/${project.shortId}/experiments/${experiment.shortId}`,
    syncedHashes: computeSyncHashes(
      experiment.triggersJs,
      experiment.variations.map((v) => ({ id: v.id, controlJs: v.controlJs, controlCss: v.controlCss }))
    ),
  }

  writeManifest(baseDir, manifest)
  files.push('.avsb.json')

  if (script === 'ts') {
    fs.writeFileSync(path.join(baseDir, 'tsconfig.json'), TSCONFIG_TEMPLATE)
    files.push('tsconfig.json')
    files.push(...writeTypeDefinitions(baseDir))
  }

  return { dir: baseDir, files }
}

/**
 * Rewrite the declaration files in an existing TypeScript folder when they have
 * fallen behind the installed CLI. Returns the filenames that changed.
 *
 * JavaScript folders have none, and a folder whose files are already current is
 * left alone, so `avsb pull` stays quiet when nothing moved.
 */
export function refreshTypeDefinitions(dir: string, script: 'js' | 'ts'): string[] {
  if (script !== 'ts') return []

  let current: Array<{ filename: string; contents: string }>
  try {
    current = readSnippetTypeDefs()
  } catch {
    // `avsb pull` is about experiment code; a missing declaration copy must not
    // stop it. The scaffold path reports the same problem loudly at clone time.
    return []
  }

  const changed: string[] = []
  for (const file of current) {
    const target = path.join(dir, file.filename)
    const onDisk = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null
    if (onDisk === file.contents) continue
    fs.writeFileSync(target, file.contents)
    changed.push(file.filename)
  }
  return changed
}

export function updateLocalFiles(
  dir: string,
  manifest: AvsbManifest,
  data: ApiExperimentResponse['data']
): string[] {
  const { experiment } = data
  const { script, style } = manifest.languages
  const updated: string[] = []

  // Refresh the declarations too, so a folder cloned six CLI versions ago picks
  // up the APIs the snippet has shipped since.
  updated.push(...refreshTypeDefinitions(dir, script))

  const triggerFile = `trigger.${script}`
  const triggerPath = path.join(dir, triggerFile)
  const currentTrigger = fs.existsSync(triggerPath) ? fs.readFileSync(triggerPath, 'utf-8') : ''
  if (currentTrigger !== experiment.triggersJs) {
    fs.writeFileSync(triggerPath, experiment.triggersJs)
    updated.push(triggerFile)
  }

  for (const variation of experiment.variations) {
    const mv = manifest.variations.find((v) => v.id === variation.id)
    if (!mv) continue

    const jsPath = path.join(dir, mv.folder, mv.scriptFile)
    const cssPath = path.join(dir, mv.folder, mv.styleFile)

    const currentJs = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf-8') : ''
    const currentCss = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf-8') : ''

    if (currentJs !== variation.controlJs) {
      fs.writeFileSync(jsPath, variation.controlJs)
      updated.push(`${mv.folder}/${mv.scriptFile}`)
    }
    if (currentCss !== variation.controlCss) {
      fs.writeFileSync(cssPath, variation.controlCss)
      updated.push(`${mv.folder}/${mv.styleFile}`)
    }
  }

  manifest.status = experiment.status
  manifest.trafficAlloc = experiment.trafficAlloc
  manifest.targetingRules = experiment.targetingRules
  manifest.lastSyncedAt = new Date().toISOString()

  manifest.variations = experiment.variations.map((v) => {
    const existing = manifest.variations.find((mv) => mv.id === v.id)
    const folder = existing?.folder ?? variationFolderName(v.name)
    return {
      id: v.id,
      shortId: v.shortId,
      name: v.name,
      type: v.type,
      weight: v.weight,
      folder,
      scriptFile: existing?.scriptFile ?? `${folder}.${script}`,
      styleFile: existing?.styleFile ?? `${folder}.${style}`,
    }
  })

  manifest.syncedHashes = computeSyncHashes(
    experiment.triggersJs,
    experiment.variations.map((v) => ({ id: v.id, controlJs: v.controlJs, controlCss: v.controlCss }))
  )

  writeManifest(dir, manifest)

  return updated
}

export function diffLocalFiles(
  dir: string,
  manifest: AvsbManifest,
  data: ApiExperimentResponse['data']
): string[] {
  const { experiment } = data
  const { script } = manifest.languages
  const changed: string[] = []

  const triggerFile = `trigger.${script}`
  const triggerPath = path.join(dir, triggerFile)
  if (fs.existsSync(triggerPath)) {
    const localContent = fs.readFileSync(triggerPath, 'utf-8')
    if (localContent !== experiment.triggersJs) {
      changed.push(triggerFile)
    }
  }

  for (const variation of experiment.variations) {
    const mv = manifest.variations.find((v) => v.id === variation.id)
    if (!mv) continue

    const jsPath = path.join(dir, mv.folder, mv.scriptFile)
    const cssPath = path.join(dir, mv.folder, mv.styleFile)

    if (fs.existsSync(jsPath)) {
      const localJs = fs.readFileSync(jsPath, 'utf-8')
      if (localJs !== variation.controlJs) {
        changed.push(`${mv.folder}/${mv.scriptFile}`)
      }
    }

    if (fs.existsSync(cssPath)) {
      const localCss = fs.readFileSync(cssPath, 'utf-8')
      if (localCss !== variation.controlCss) {
        changed.push(`${mv.folder}/${mv.styleFile}`)
      }
    }
  }

  return changed
}
