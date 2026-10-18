/**
 * The request `avsb push` sends, built from a clone folder, and the way back
 * from a request-body path to the file on disk.
 *
 * Every file travels as `{ source, compiled }`: the source is what the
 * developer wrote and what `avsb pull` gives back, the compiled output is what
 * visitors run. The platform stores both, exactly as the dashboard editor's
 * save does. Compiling here means a TypeScript or SCSS error stops the push
 * before any request, with the file, line and column of the problem.
 *
 * The payload lists variations in manifest order, which is what lets
 * `labelForPushPath` turn `variations.1.controlCss` back into the folder and
 * file the developer edited.
 */

import fs from 'node:fs'
import path from 'node:path'
import { compileScript, compileStyle, type CompileError } from '../lib/compiler.js'
import type { AvsbManifest } from '../types/experiment.js'

export interface PushPair {
  source: string
  compiled: string
}

export interface PushPayload {
  triggersJs: PushPair
  variations: Array<{ id: string; controlJs: PushPair; controlCss: PushPair }>
}

/** The raw sources, for the sync hashes the manifest keeps after a push. */
export interface PushSources {
  triggersJs: string
  variations: Array<{ id: string; controlJs: string; controlCss: string }>
}

export type BuildPushResult =
  | { ok: true; payload: PushPayload; sources: PushSources }
  | { ok: false; summary: string; errors: CompileError[] }

/** Paths relative to the clone folder, the way the developer sees them. */
function triggerFile(manifest: AvsbManifest): string {
  return `trigger.${manifest.languages.script}`
}

function variationFile(manifest: AvsbManifest, index: number, kind: 'script' | 'style'): string | undefined {
  const variation = manifest.variations[index]
  if (!variation) return undefined
  return path.posix.join(variation.folder, kind === 'script' ? variation.scriptFile : variation.styleFile)
}

/**
 * The local file a request-body path points into, or undefined when the path
 * is not about a file (an unknown key, the body itself).
 */
export function labelForPushPath(
  manifest: AvsbManifest,
  bodyPath: ReadonlyArray<string | number>,
): string | undefined {
  const [head, index, field] = bodyPath
  if (head === 'triggersJs') return triggerFile(manifest)
  if (head !== 'variations' || typeof index !== 'number') return undefined
  if (field === 'controlJs') return variationFile(manifest, index, 'script')
  if (field === 'controlCss') return variationFile(manifest, index, 'style')
  return manifest.variations[index]?.folder
}

function readSource(dir: string, relativePath: string): { source: string } | { missing: CompileError } {
  const absolute = path.join(dir, relativePath)
  if (!fs.existsSync(absolute)) {
    return {
      missing: {
        file: relativePath,
        line: 0,
        column: 0,
        message: 'File not found. Restore it, or run `avsb pull --force` to get the platform copy back.',
      },
    }
  }
  return { source: fs.readFileSync(absolute, 'utf-8') }
}

/**
 * Read and compile every file the manifest lists. Stops at the first file that
 * fails, so the summary names one thing to fix.
 */
export async function buildPushPayload(dir: string, manifest: AvsbManifest): Promise<BuildPushResult> {
  const scriptLang = manifest.languages.script === 'ts' ? 'TYPESCRIPT' : 'JAVASCRIPT'
  const styleLang = manifest.languages.style === 'scss' ? 'SCSS' : 'CSS'

  const triggerPath = triggerFile(manifest)
  const trigger = readSource(dir, triggerPath)
  if ('missing' in trigger) return { ok: false, summary: `${triggerPath} is missing`, errors: [trigger.missing] }
  const triggerCompile = await compileScript(trigger.source, scriptLang, triggerPath)
  if (!triggerCompile.success) {
    return { ok: false, summary: 'Trigger compilation failed', errors: triggerCompile.errors }
  }

  const payload: PushPayload = {
    triggersJs: { source: trigger.source, compiled: triggerCompile.code },
    variations: [],
  }
  const sources: PushSources = { triggersJs: trigger.source, variations: [] }

  for (const [index, variation] of manifest.variations.entries()) {
    const scriptPath = variationFile(manifest, index, 'script') ?? variation.scriptFile
    const stylePath = variationFile(manifest, index, 'style') ?? variation.styleFile

    const script = readSource(dir, scriptPath)
    if ('missing' in script) return { ok: false, summary: `${scriptPath} is missing`, errors: [script.missing] }
    const style = readSource(dir, stylePath)
    if ('missing' in style) return { ok: false, summary: `${stylePath} is missing`, errors: [style.missing] }

    const jsCompile = await compileScript(script.source, scriptLang, scriptPath)
    if (!jsCompile.success) {
      return { ok: false, summary: `Variation "${variation.name}" script compilation failed`, errors: jsCompile.errors }
    }
    const cssCompile = compileStyle(style.source, styleLang, stylePath)
    if (!cssCompile.success) {
      return { ok: false, summary: `Variation "${variation.name}" style compilation failed`, errors: cssCompile.errors }
    }

    payload.variations.push({
      id: variation.id,
      controlJs: { source: script.source, compiled: jsCompile.code },
      controlCss: { source: style.source, compiled: cssCompile.code },
    })
    sources.variations.push({ id: variation.id, controlJs: script.source, controlCss: style.source })
  }

  return { ok: true, payload, sources }
}

/** The question asked after a push saved pending changes, worded for the status. */
export function publishPromptFor(status: string | undefined): string {
  if (status === 'PAUSED') {
    return 'The experiment is paused. Publish the changes now? (Visitors see them when it resumes.)'
  }
  return 'The experiment is running. Publish the changes now?'
}
