/**
 * Keeping the environment file `avsb init` writes out of git.
 *
 * In a fresh repository `init` wrote `.env.local` (or `.env`) and left it
 * untracked but committable, one `git add .` away from a commit (QA N4-16).
 * The SDK key in it is a public identifier, so this is hygiene rather than a
 * leak, but environment files are where real secrets land next, and every
 * framework's own starter ignores them.
 *
 * The rule: inside a git repository, when git does not already ignore the
 * file, one line naming it is appended to `.gitignore` in the project
 * directory (created when missing), under a banner saying what wrote it.
 * Outside a repository, or when git is not installed, nothing is touched.
 *
 * `git check-ignore` decides, not a parser here: it is the only reader that
 * knows every rule (nested `.gitignore` files, global excludes, negations).
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const GITIGNORE_BANNER = '# A vs B: the SDK key file `avsb init` writes'

export type IgnoreState = 'ignored' | 'not-ignored' | 'no-repo'

/** What git says about one path, relative to `dir`. */
export function gitIgnoreState(dir: string, file: string): IgnoreState {
  const result = spawnSync('git', ['check-ignore', '-q', '--', file], { cwd: dir, stdio: 'ignore' })
  // No git on PATH: nothing to protect from.
  if (result.error) return 'no-repo'
  if (result.status === 0) return 'ignored'
  if (result.status === 1) return 'not-ignored'
  // 128: not a repository (or a git error), so not ours to edit.
  return 'no-repo'
}

/** `.gitignore` with the entry appended, ending in a newline. Pure. */
export function appendGitignoreEntry(existing: string | null, file: string): string {
  const entry = `${GITIGNORE_BANNER}\n${file}\n`
  if (existing === null || existing.length === 0) return entry
  const separator = existing.endsWith('\n') ? '\n' : '\n\n'
  return `${existing}${separator}${entry}`
}

export type GitignoreOutcome = 'added' | 'already-ignored' | 'no-repo'

export interface GitignoreResult {
  outcome: GitignoreOutcome
  /** The `.gitignore` that was written, when one was. */
  gitignorePath: string | null
}

/** Make sure git ignores `file` (relative to `dir`). Writes only on 'added'. */
export function ensureGitignored(
  dir: string,
  file: string,
  state: (dir: string, file: string) => IgnoreState = gitIgnoreState,
): GitignoreResult {
  const current = state(dir, file)
  if (current === 'ignored') return { outcome: 'already-ignored', gitignorePath: null }
  if (current === 'no-repo') return { outcome: 'no-repo', gitignorePath: null }

  const gitignorePath = path.join(dir, '.gitignore')
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : null
  fs.writeFileSync(gitignorePath, appendGitignoreEntry(existing, file), 'utf-8')
  return { outcome: 'added', gitignorePath }
}
