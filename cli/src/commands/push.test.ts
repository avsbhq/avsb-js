import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiRequestError, describeApiFailure } from '../lib/apiError.js'
import { buildPushPayload, labelForPushPath, publishPromptFor } from './push.payload.js'
import type { AvsbManifest } from '../types/experiment.js'

function makeManifest(script: 'js' | 'ts', style: 'css' | 'scss'): AvsbManifest {
  return {
    version: 1,
    experimentId: 'exp_1',
    experimentShortId: 300021,
    experimentName: 'Homepage headline',
    projectId: 'proj_1',
    projectShortId: 200009,
    orgId: 'org-1',
    snippetKey: 'snip_abc',
    status: 'RUNNING',
    languages: { script, style },
    trafficAlloc: 100,
    targetingRules: [],
    variations: [
      { id: 'var_control', shortId: 1, name: 'Control', type: 'CONTROL', weight: 0.5, folder: 'control', scriptFile: `control.${script}`, styleFile: `control.${style}` },
      { id: 'var_b', shortId: 2, name: 'Variant B', type: 'VARIANT', weight: 0.5, folder: 'variant-b', scriptFile: `variant-b.${script}`, styleFile: `variant-b.${style}` },
    ],
    allowedVariations: [1, 2],
    lastSyncedAt: '2026-10-01T10:00:00.000Z',
    platformUrl: 'https://app.avsb.cloud/projects/200009/experiments/300021',
  }
}

let dir = ''

function write(relative: string, contents: string): void {
  const absolute = path.join(dir, relative)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, contents)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avsb-push-test-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('buildPushPayload', () => {
  it('sends every file as { source, compiled }, in manifest order (N4-2)', async () => {
    const manifest = makeManifest('ts', 'scss')
    write('trigger.ts', 'function initTrigger(options: unknown, activate: () => void) { activate() }')
    write('control/control.ts', '')
    write('control/control.scss', '')
    write('variant-b/variant-b.ts', 'function initVariation(options: unknown) { const n: number = 1; void n }')
    write('variant-b/variant-b.scss', '$c: red; .hero { h1 { color: $c; } }')

    const result = await buildPushPayload(dir, manifest)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.payload)).toEqual(['triggersJs', 'variations'])
    expect(result.payload.variations.map((v) => v.id)).toEqual(['var_control', 'var_b'])
    const variantB = result.payload.variations[1]
    expect(variantB.controlJs.source).toContain('const n: number = 1')
    expect(variantB.controlJs.compiled).not.toContain(': number')
    expect(variantB.controlCss.source).toBe('$c: red; .hero { h1 { color: $c; } }')
    expect(variantB.controlCss.compiled).toContain('.hero h1')
    // The sync hashes are taken from what the platform stores: the source.
    expect(result.sources.variations[1]).toEqual({
      id: 'var_b',
      controlJs: variantB.controlJs.source,
      controlCss: variantB.controlCss.source,
    })
  })

  it('stops at a compile error with the local file, line and column, before any request', async () => {
    const manifest = makeManifest('js', 'scss')
    write('trigger.js', 'function initTrigger(options, activate) { activate() }')
    write('control/control.js', '')
    write('control/control.scss', '.a {')
    write('variant-b/variant-b.js', '')
    write('variant-b/variant-b.scss', '')

    const result = await buildPushPayload(dir, manifest)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.summary).toBe('Variation "Control" style compilation failed')
    expect(result.errors[0].file).toBe('control/control.scss')
    expect(result.errors[0].line).toBeGreaterThan(0)
  })

  it('names a missing file instead of throwing ENOENT', async () => {
    const manifest = makeManifest('js', 'css')
    write('trigger.js', '')

    const result = await buildPushPayload(dir, manifest)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.summary).toBe('control/control.js is missing')
    expect(result.errors[0].message).toContain('avsb pull --force')
  })
})

describe('a refused push names the file on disk', () => {
  const manifest = makeManifest('ts', 'scss')
  const label = (bodyPath: ReadonlyArray<string | number>) => labelForPushPath(manifest, bodyPath)

  it('maps request-body paths back to the clone folder', () => {
    expect(label(['triggersJs'])).toBe('trigger.ts')
    expect(label(['variations', 1, 'controlJs', 'compiled'])).toBe('variant-b/variant-b.ts')
    expect(label(['variations', 0, 'controlCss'])).toBe('control/control.scss')
    expect(label(['variations', 7, 'controlJs'])).toBeUndefined()
    expect(label(['somethingElse'])).toBeUndefined()
  })

  it('prints the file and the field for a 400, not the raw schema message', () => {
    const error = new ApiRequestError({
      status: 400,
      code: 'validation_failed',
      message: 'Request body failed validation',
      details: {
        issues: [
          {
            param: 'variations.1.controlJs.source',
            path: ['variations', 1, 'controlJs', 'source'],
            code: 'custom',
            message: 'Variation code must define an initVariation(options) function.',
          },
        ],
      },
    })

    expect(describeApiFailure(error, label)[0]).toBe(
      'variant-b/variant-b.ts (variations.1.controlJs.source): Variation code must define an initVariation(options) function.',
    )
  })

  it('prints file:line:col for a 422 the platform could not parse', () => {
    const error = new ApiRequestError({
      status: 422,
      code: 'validation_failed',
      message: 'Fix the syntax errors before pushing',
      details: {
        compilationErrors: [
          { file: 'Variant B.js', line: 3, column: 7, message: 'Unexpected "}"', path: ['variations', 1, 'controlJs'] },
        ],
      },
    })

    expect(describeApiFailure(error, label)[0]).toBe('variant-b/variant-b.ts:3:7: Unexpected "}"')
  })
})

describe('publishPromptFor', () => {
  it('words the question for the status the push reported', () => {
    expect(publishPromptFor('RUNNING')).toBe('The experiment is running. Publish the changes now?')
    expect(publishPromptFor('PAUSED')).toContain('when it resumes')
    expect(publishPromptFor(undefined)).toBe('The experiment is running. Publish the changes now?')
  })
})
