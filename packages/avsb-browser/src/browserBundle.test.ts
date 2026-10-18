// =====================================================================
// Packaging guard: a customer must be able to bundle this package for the web.
//
// The first production smoke run could not build a browser page against
// @avsbhq/browser at all: the client value-imported `createSnapshotStore` and
// `createUtils` from the `@avsbhq/utils` ROOT barrel, and the root
// transitively reaches `node:async_hooks` (request scoping) and a
// `node:fs/promises` bootstrap read. Every browser bundler then failed with
// "Could not resolve async_hooks" / "Could not resolve fs/promises", so the
// package was unusable in the one runtime it exists for.
//
// The fix is the leaf-subpath architecture the utils package already
// documents (`./backoff`, `./sdkKey`, `./exposure`, and now `./snapshot` and
// `./createUtils`): browser code takes VALUES from a leaf, never from the
// root. These tests fail the moment that rule is broken again.
//
// Modules resolve to the workspace SOURCE, not to `dist`, so the guard runs on
// a clean checkout with nothing built. Test 4 covers what source resolution
// cannot see: that the leaf is actually published.
// =====================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const BROWSER_SRC = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(BROWSER_SRC, '..', '..', '..')
const UTILS_DIR = join(REPO_ROOT, 'packages', 'avsb-utils')

/** Workspace packages this guard resolves from source instead of from dist. */
const SOURCE_PACKAGES: ReadonlyArray<readonly [string, string]> = [
  ['@avsbhq/core', join(REPO_ROOT, 'packages', 'avsb-core', 'src')],
  ['@avsbhq/utils', join(UTILS_DIR, 'src')],
]

// --- esbuild, loaded the way smoke/src/web/bundle.ts loads it -------------
// The specifier is annotated as `string` so the type checker treats it as
// unresolvable and this file never depends on esbuild's types being installed.

interface EsbuildMessage {
  text: string
}
interface EsbuildFailure {
  errors?: EsbuildMessage[]
}
interface EsbuildModule {
  build(options: Record<string, unknown>): Promise<unknown>
}

async function loadEsbuild(): Promise<EsbuildModule> {
  const specifier: string = 'esbuild'
  const imported: unknown = await import(specifier)
  if (
    typeof imported === 'object' &&
    imported !== null &&
    'build' in imported &&
    typeof (imported as EsbuildModule).build === 'function'
  ) {
    return imported as EsbuildModule
  }
  const fallback = (imported as { default?: unknown }).default
  if (
    typeof fallback === 'object' &&
    fallback !== null &&
    'build' in fallback &&
    typeof (fallback as EsbuildModule).build === 'function'
  ) {
    return fallback as EsbuildModule
  }
  throw new Error('The installed esbuild does not expose build()')
}

function esbuildErrorText(error: unknown): string {
  const failure = error as EsbuildFailure
  const errors = Array.isArray(failure?.errors) ? failure.errors : []
  if (errors.length > 0) return errors.map((e) => e.text).join('; ')
  return error instanceof Error ? error.message : String(error)
}

/**
 * Bundle `entry` for the browser with `@avsbhq/*` resolved to workspace
 * source. Resolves to null on success, or to the bundler's error text.
 */
async function bundleForBrowser(entry: string): Promise<string | null> {
  const esbuild = await loadEsbuild()
  const sourceResolution = {
    name: 'avsb-workspace-source',
    setup(build: {
      onResolve(
        options: { filter: RegExp },
        callback: (args: { path: string }) => { path: string } | null
      ): void
    }): void {
      build.onResolve({ filter: /^@avsbhq\// }, (args) => {
        for (const [pkg, dir] of SOURCE_PACKAGES) {
          if (args.path === pkg) return { path: join(dir, 'index.ts') }
          if (args.path.startsWith(`${pkg}/`)) {
            return { path: join(dir, `${args.path.slice(pkg.length + 1)}.ts`) }
          }
        }
        return null
      })
    },
  }

  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      logLevel: 'silent',
      absWorkingDir: REPO_ROOT,
      plugins: [sourceResolution],
    })
    return null
  } catch (error) {
    return esbuildErrorText(error)
  }
}

// --- Static scan ----------------------------------------------------------

interface RootImport {
  file: string
  line: number
  statement: string
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(name)) continue
    if (name.endsWith('.test.ts') || name.endsWith('.test.tsx')) continue
    out.push(full)
  }
  return out
}

/**
 * Every `import`/`export ... from '@avsbhq/utils'` that is NOT type-only.
 * A type-only statement erases at build time and can never reach a bundle;
 * a value one drags the whole node-side root barrel in.
 */
function findRootValueImports(): RootImport[] {
  const found: RootImport[] = []
  for (const file of sourceFiles(BROWSER_SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, index) => {
      const trimmed = line.trim()
      if (!/from\s+'@avsbhq\/utils'/.test(trimmed)) return
      if (/^(import|export)\s+type\b/.test(trimmed)) return
      if (!/^(import|export)\b/.test(trimmed)) return
      found.push({
        file: file.slice(REPO_ROOT.length + 1),
        line: index + 1,
        statement: trimmed,
      })
    })
  }
  return found
}

/** Every `@avsbhq/utils/<subpath>` specifier this package imports. */
function utilsSubpathsUsed(): string[] {
  const used = new Set<string>()
  for (const file of sourceFiles(BROWSER_SRC)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/'@avsbhq\/utils\/([A-Za-z0-9/_-]+)'/g)) {
      used.add(match[1])
    }
  }
  return [...used].sort()
}

// --- Tests ----------------------------------------------------------------

describe('@avsbhq/browser is bundleable for the web', () => {
  it('takes no runtime value from the @avsbhq/utils root barrel', () => {
    const offenders = findRootValueImports()

    expect(
      offenders,
      offenders.length === 0
        ? ''
        : 'Browser source must import VALUES from a @avsbhq/utils leaf subpath. ' +
          'The root barrel reaches node:async_hooks and node:fs/promises, so a ' +
          'value import from it breaks every customer browser build:\n' +
          offenders
            .map((o) => `  ${o.file}:${o.line}  ${o.statement}`)
            .join('\n')
    ).toEqual([])
  })

  it('bundles the package entry for platform browser', async () => {
    const failure = await bundleForBrowser(join(BROWSER_SRC, 'index.ts'))

    expect(
      failure,
      failure === null
        ? ''
        : `Bundling @avsbhq/browser for the browser failed: ${failure}`
    ).toBeNull()
  }, 60_000)

  // Negative control. Without it, an esbuild that stopped treating node
  // builtins as unresolvable under platform:'browser' would leave the test
  // above passing forever while the real defect walked back in.
  it('detects a node-only module, so the check above has teeth', async () => {
    const failure = await bundleForBrowser(join(UTILS_DIR, 'src', 'index.ts'))

    expect(failure).not.toBeNull()
    expect(failure).toMatch(/Could not resolve/)
    expect(failure).toMatch(/async_hooks|fs\/promises/)
  }, 60_000)

  it('imports only utils subpaths that the utils package actually publishes', () => {
    const pkg = JSON.parse(
      readFileSync(join(UTILS_DIR, 'package.json'), 'utf8')
    ) as { exports?: Record<string, unknown> }
    const tsupConfig = readFileSync(join(UTILS_DIR, 'tsup.config.ts'), 'utf8')
    const declared = Object.keys(pkg.exports ?? {})

    const undeclared = utilsSubpathsUsed().filter(
      (subpath) =>
        !declared.includes(`./${subpath}`) ||
        !tsupConfig.includes(`'src/${subpath}.ts'`)
    )

    expect(
      undeclared,
      undeclared.length === 0
        ? ''
        : 'These @avsbhq/utils subpaths are imported by the browser package but ' +
          'are not both declared in the utils package.json "exports" map and ' +
          `built as a tsup entry, so they resolve to nothing once published: ${undeclared.join(', ')}`
    ).toEqual([])
  })
})
