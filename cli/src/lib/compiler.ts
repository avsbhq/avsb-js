import { transform } from 'esbuild'
import * as sass from 'sass'
import fs from 'node:fs'
import path from 'node:path'
import type { AvsbManifest } from '../types/experiment.js'
import type { CompiledExperiment, CompiledVariation } from '../types/dev.js'

export type CompileError = {
  file: string
  line: number
  column: number
  message: string
}

export type CompileScriptResult =
  | { success: true; code: string }
  | { success: false; errors: CompileError[] }

export type CompileStyleResult = CompileScriptResult

export async function compileTypeScript(source: string): Promise<string> {
  const result = await transform(source, {
    loader: 'ts',
    target: 'es2017',
  })
  return result.code
}

export function compileScss(filePath: string): string {
  const result = sass.compile(filePath, {
    style: 'expanded',
    loadPaths: [path.dirname(filePath)],
  })
  return result.css
}

export async function compileScript(
  source: string,
  lang: 'JAVASCRIPT' | 'TYPESCRIPT',
  fileName: string,
  opts?: { minify?: boolean },
): Promise<CompileScriptResult> {
  if (lang === 'JAVASCRIPT' && !opts?.minify) {
    return { success: true, code: source }
  }

  try {
    const result = await transform(source, {
      loader: lang === 'TYPESCRIPT' ? 'ts' : 'js',
      target: 'es2017',
      minify: opts?.minify ?? false,
      sourcefile: fileName,
    })
    return { success: true, code: result.code }
  } catch (err: unknown) {
    return { success: false, errors: parseEsbuildErrors(err, fileName) }
  }
}

export function compileStyle(
  source: string,
  lang: 'CSS' | 'SCSS',
  fileName: string,
): CompileStyleResult {
  if (lang === 'CSS') {
    return { success: true, code: source }
  }

  try {
    const result = sass.compileString(source, { style: 'expanded' })
    return { success: true, code: result.css }
  } catch (err: unknown) {
    if (err instanceof sass.Exception) {
      return {
        success: false,
        errors: [
          {
            file: fileName,
            line: (err.span?.start?.line ?? 0) + 1,
            column: (err.span?.start?.column ?? 0) + 1,
            message: err.sassMessage,
          },
        ],
      }
    }
    return {
      success: false,
      errors: [
        {
          file: fileName,
          line: 0,
          column: 0,
          message: err instanceof Error ? err.message : 'SCSS compilation failed',
        },
      ],
    }
  }
}

type EsbuildErrorLike = {
  errors?: Array<{
    text?: string
    location?: { line?: number; column?: number; file?: string } | null
  }>
}

function parseEsbuildErrors(err: unknown, fallbackFile: string): CompileError[] {
  if (typeof err === 'object' && err !== null && 'errors' in err) {
    const errors = (err as EsbuildErrorLike).errors
    if (Array.isArray(errors) && errors.length > 0) {
      return errors.map((e) => ({
        file: e.location?.file || fallbackFile,
        line: e.location?.line ?? 0,
        column: (e.location?.column ?? 0) + 1,
        message: e.text || 'Compilation failed',
      }))
    }
  }
  return [
    {
      file: fallbackFile,
      line: 0,
      column: 0,
      message: err instanceof Error ? err.message : 'Compilation failed',
    },
  ]
}

export async function compileFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath)
  const source = fs.readFileSync(filePath, 'utf-8')

  switch (ext) {
    case '.ts':
      return compileTypeScript(source)
    case '.scss':
      return compileScss(filePath)
    case '.js':
    case '.css':
      return source
    default:
      return source
  }
}

export async function compileExperiment(
  dir: string,
  manifest: AvsbManifest
): Promise<CompiledExperiment> {
  const { script } = manifest.languages

  const triggerPath = path.join(dir, `trigger.${script}`)
  let triggersJs = ''
  if (fs.existsSync(triggerPath)) {
    triggersJs = await compileFile(triggerPath)
  }

  const variations: CompiledVariation[] = []

  for (const v of manifest.variations) {
    const jsPath = path.join(dir, v.folder, v.scriptFile)
    const cssPath = path.join(dir, v.folder, v.styleFile)

    let js = ''
    let css = ''

    if (fs.existsSync(jsPath)) {
      js = await compileFile(jsPath)
    }
    if (fs.existsSync(cssPath)) {
      css = await compileFile(cssPath)
    }

    variations.push({
      variationId: v.id,
      name: v.name,
      type: v.type,
      js,
      css,
    })
  }

  return {
    experimentId: manifest.experimentId,
    triggersJs,
    variations,
    compiledAt: Date.now(),
  }
}

export function detectChangeType(
  filePath: string
): 'css-only' | 'js-only' | 'trigger' | 'both' {
  const basename = path.basename(filePath, path.extname(filePath))
  const ext = path.extname(filePath)

  if (basename === 'trigger') return 'trigger'
  if (ext === '.scss' || ext === '.css') return 'css-only'
  if (ext === '.ts' || ext === '.js') return 'js-only'
  return 'both'
}
