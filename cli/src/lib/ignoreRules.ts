/**
 * Which files `avsb find-refs` is allowed to read.
 *
 * A repository scan that walks `node_modules` is a scan nobody runs twice, and
 * one that reports a flag as "never referenced" because it skipped the folder
 * the code lives in is worse than no scan at all. So the rules are explicit:
 * a fixed list of directories that are never source, plus the project's own
 * `.gitignore` files, plus whatever `--ignore` adds.
 *
 * A DELIBERATE SUBSET of gitignore. Supported: comments, blank lines, negation
 * with `!`, directory-only patterns with a trailing `/`, anchoring with a
 * leading or embedded `/`, `*`, `**`, `?`, and `[...]` classes. Not supported:
 * escaped `#`/`!`/trailing-space literals, and `.git/info/exclude` or the
 * global excludes file. Anything unsupported is treated as a literal, so the
 * failure mode is scanning a file that git would have skipped, never skipping
 * a file that matters.
 */

import path from 'node:path'

/** Never source, in any project. Skipped before any `.gitignore` is read. */
export const ALWAYS_SKIPPED_DIRECTORIES: readonly string[] = [
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.yarn',
  '.pnpm-store',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'target',
]

export interface IgnoreRule {
  /** Tested against the path relative to `base`, in posix form. */
  matcher: RegExp
  negated: boolean
  directoryOnly: boolean
  /** Posix directory the rule was declared in, relative to the scan root. */
  base: string
}

/**
 * Compile one `.gitignore` file. `base` is the directory it sits in, relative
 * to the scan root, so a nested ignore file only governs its own subtree.
 */
export function parseIgnoreFile(contents: string, base = ''): IgnoreRule[] {
  const rules: IgnoreRule[] = []

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (line.length === 0 || line.startsWith('#')) continue

    const negated = line.startsWith('!')
    let pattern = negated ? line.slice(1) : line
    if (pattern.length === 0) continue

    const directoryOnly = pattern.endsWith('/')
    if (directoryOnly) pattern = pattern.slice(0, -1)
    if (pattern.length === 0) continue

    // A pattern with a slash anywhere but the end is anchored to the directory
    // the ignore file lives in; one without matches at any depth below it.
    const anchored = pattern.includes('/')
    if (pattern.startsWith('/')) pattern = pattern.slice(1)

    const body = translateGlob(pattern)
    const prefix = anchored ? '' : '(?:.*/)?'
    rules.push({
      matcher: new RegExp(`^${prefix}${body}$`),
      negated,
      directoryOnly,
      base,
    })
  }

  return rules
}

/** Turn one gitignore pattern into a regular expression body. */
function translateGlob(pattern: string): string {
  let out = ''
  let i = 0

  while (i < pattern.length) {
    const char = pattern[i]

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` crosses any number of directories, including none.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }

    if (char === '?') {
      out += '[^/]'
      i += 1
      continue
    }

    if (char === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close > i) {
        const inner = pattern.slice(i + 1, close)
        out += `[${inner.startsWith('!') ? `^${inner.slice(1)}` : inner}]`
        i = close + 1
        continue
      }
      out += '\\['
      i += 1
      continue
    }

    out += char.replace(/[.+^${}()|\\]/g, '\\$&')
    i += 1
  }

  // A directory pattern also covers everything inside it, so `build` matches
  // `build` and `build/anything`.
  return `${out}(?:/.*)?`
}

/**
 * Should this path be skipped?
 *
 * `relPath` is posix, relative to the scan root, with no leading slash. Last
 * matching rule wins, which is what makes `!keep-me.ts` after `*.ts` work.
 */
export function isIgnored(
  relPath: string,
  isDirectory: boolean,
  rules: readonly IgnoreRule[],
): boolean {
  let ignored = false

  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue

    const scoped = relativeToBase(relPath, rule.base)
    if (scoped === null) continue
    if (rule.matcher.test(scoped)) ignored = !rule.negated
  }

  return ignored
}

/** The path as the rule's own directory sees it, or null when out of scope. */
function relativeToBase(relPath: string, base: string): string | null {
  if (base === '') return relPath
  if (relPath === base) return ''
  if (!relPath.startsWith(`${base}/`)) return null
  return relPath.slice(base.length + 1)
}

/** Absolute or OS-specific path to the posix, root-relative form rules expect. */
export function toRelativePosix(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/')
}
