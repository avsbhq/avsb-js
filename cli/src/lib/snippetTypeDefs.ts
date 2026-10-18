/**
 * The TypeScript declarations a scaffolded folder gets, read from the real
 * published files instead of a copy pasted into this repository.
 *
 * `packages/avsb-snippet-types` is the source of truth for `window.avsb` and for
 * the authoring globals (`options`, `activate`, `initProject`, …). The CLI used
 * to carry its own hand-written versions of both, which is how a scaffolded
 * `avsb.d.ts` came to be missing `track.purchase`, `ready`, `recs`, `commerce`,
 * `consent`, `datasets` and `utils`: seven APIs the snippet has shipped for
 * months, invisible to anyone writing experiment code in TypeScript.
 *
 * Where the files are found, in order:
 *   1. `dist/types/` next to the built CLI. `build.mjs` copies them there, so
 *      the published package is self-contained.
 *   2. An installed `@avsbhq/snippet-types` package, for anyone who has it.
 *   3. `packages/avsb-snippet-types` in this repository, which is what makes
 *      `npm run dev` and the tests read exactly what a user would get.
 *
 * Nothing is generated from memory: if no copy is found, the scaffold says so
 * and writes everything else, rather than shipping a stale duplicate.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { CliError } from './cliError.js'

export const SNIPPET_TYPES_PACKAGE = '@avsbhq/snippet-types'

/** The two declaration files, with the names they keep in a scaffolded folder. */
export const SNIPPET_TYPE_DEF_FILES = ['avsb.d.ts', 'variation-code.d.ts'] as const

export type SnippetTypeDefName = (typeof SNIPPET_TYPE_DEF_FILES)[number]

export interface SnippetTypeDefFile {
  filename: SnippetTypeDefName
  contents: string
}

export interface TypeDefLookup {
  /** Directory of the running module: `dist` when built, `src/lib` in development. */
  moduleDir: string
  exists: (candidate: string) => boolean
  /** Directory of the installed `@avsbhq/snippet-types`, or null when absent. */
  packageDir: () => string | null
  /**
   * True for the directory that ends the search: a repository root. Defaults to
   * "contains a `.git` entry", which is true for a clone and for a worktree
   * (where `.git` is a file).
   */
  isRepoRoot?: (dir: string) => boolean
}

/** Stops a symlink loop or an unexpected filesystem from spinning forever. */
const MAX_WALK_UP = 24

/**
 * Every path worth trying for one declaration file, in priority order. Pure, so
 * the resolution rules can be tested without a filesystem or a build.
 *
 * The walk stops at the repository root rather than after a fixed number of
 * parents: a deep worktree used to run out of hops before reaching `packages/`,
 * and a shallow one used to probe directories above the repository.
 */
export function snippetTypeDefCandidates(
  filename: string,
  lookup: Pick<TypeDefLookup, 'moduleDir' | 'packageDir' | 'isRepoRoot'>,
): string[] {
  const candidates: string[] = [path.join(lookup.moduleDir, 'types', filename)]

  const packageDir = lookup.packageDir()
  if (packageDir) candidates.push(path.join(packageDir, filename))

  const isRepoRoot = lookup.isRepoRoot ?? defaultIsRepoRoot
  let dir = lookup.moduleDir
  for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
    candidates.push(path.join(dir, 'packages', 'avsb-snippet-types', filename))
    // The root itself is searched (the line above), then the walk ends: nothing
    // above a repository root belongs to this project.
    if (isRepoRoot(dir)) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return candidates
}

/** A repository root carries a `.git` entry: a directory in a clone, a file in a worktree. */
function defaultIsRepoRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'))
}

/** The first candidate that exists, or null. */
export function findSnippetTypeDefPath(
  filename: string,
  lookup: TypeDefLookup,
): string | null {
  for (const candidate of snippetTypeDefCandidates(filename, lookup)) {
    if (lookup.exists(candidate)) return candidate
  }
  return null
}

/** Marks the file as a copy, and says where the original lives. */
export function typeDefBanner(filename: string): string {
  return [
    `// Copied by @avsbhq/cli from ${SNIPPET_TYPES_PACKAGE}/${filename}.`,
    '// Do not edit: `avsb pull` rewrites it from the installed CLI.',
    '',
  ].join('\n')
}

function defaultPackageDir(): string | null {
  try {
    const moduleRequire = createRequire(import.meta.url)
    return path.dirname(moduleRequire.resolve(`${SNIPPET_TYPES_PACKAGE}/package.json`))
  } catch {
    return null
  }
}

function defaultLookup(): TypeDefLookup {
  return {
    moduleDir: path.dirname(fileURLToPath(import.meta.url)),
    exists: (candidate) => fs.existsSync(candidate),
    packageDir: defaultPackageDir,
  }
}

/**
 * Read both declaration files. Throws a `CliError` naming the package when they
 * cannot be found, so a broken install is reported rather than papered over.
 */
export function readSnippetTypeDefs(lookup: TypeDefLookup = defaultLookup()): SnippetTypeDefFile[] {
  return SNIPPET_TYPE_DEF_FILES.map((filename) => {
    const found = findSnippetTypeDefPath(filename, lookup)
    if (!found) {
      throw new CliError(
        'cli_io_failed',
        `Could not find ${filename} from ${SNIPPET_TYPES_PACKAGE}.`,
        [
          'The type definitions ship with the CLI, so this usually means a partial install.',
          'Reinstall with `npm install -g @avsbhq/cli`, then run the command again.',
        ],
      )
    }
    return { filename, contents: typeDefBanner(filename) + fs.readFileSync(found, 'utf-8') }
  })
}
