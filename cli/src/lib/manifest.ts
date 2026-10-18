import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { CliError } from './cliError.js'
import { failCommand } from './output.js'
import type { AvsbManifest, SyncedHashes } from '../types/experiment.js'

const MANIFEST_FILENAME = '.avsb.json'

export function parseExperimentInput(input: string): number {
  const urlMatch = input.match(/experiments\/(\d+)/)
  if (urlMatch) return parseInt(urlMatch[1], 10)

  const prefixed = input.replace(/^EXP-/i, '')
  const num = parseInt(prefixed, 10)
  if (Number.isNaN(num)) {
    throw new Error(`Cannot parse experiment ID from: ${input}`)
  }
  return num
}

export function findManifest(startDir?: string): AvsbManifest | null {
  let dir = startDir ?? process.cwd()

  for (let i = 0; i < 10; i++) {
    const manifestPath = path.join(dir, MANIFEST_FILENAME)
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf-8')
      return JSON.parse(raw) as AvsbManifest
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

export function findManifestDir(startDir?: string): string | null {
  let dir = startDir ?? process.cwd()

  for (let i = 0; i < 10; i++) {
    const manifestPath = path.join(dir, MANIFEST_FILENAME)
    if (fs.existsSync(manifestPath)) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

export function writeManifest(dir: string, manifest: AvsbManifest): void {
  const manifestPath = path.join(dir, MANIFEST_FILENAME)
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}

export function readManifestOrExit(startDir?: string): { manifest: AvsbManifest; dir: string } {
  const dir = findManifestDir(startDir)
  if (!dir) {
    failCommand(
      new CliError('cli_no_manifest', 'No .avsb.json found in this folder or above it.', [
        'Run `avsb clone <experiment>` first, or change into the folder it created.',
      ]),
    )
  }
  const manifest = findManifest(dir)!
  return { manifest, dir }
}

export function toKebabCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
}

export function variationFolderName(name: string): string {
  return toKebabCase(name)
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function computeSyncHashes(
  triggersJs: string,
  variations: Array<{ id: string; controlJs: string; controlCss: string }>
): SyncedHashes {
  const variationHashes: SyncedHashes['variations'] = {}
  for (const v of variations) {
    variationHashes[v.id] = {
      controlJs: sha256(v.controlJs),
      controlCss: sha256(v.controlCss),
    }
  }
  return {
    triggersJs: sha256(triggersJs),
    variations: variationHashes,
  }
}
