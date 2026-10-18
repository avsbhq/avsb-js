import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendGitignoreEntry, ensureGitignored, gitIgnoreState, GITIGNORE_BANNER } from './gitignore.js'

let dir = ''

function git(...args: string[]): void {
  spawnSync('git', args, { cwd: dir, stdio: 'ignore' })
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avsb-gitignore-test-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('appendGitignoreEntry', () => {
  it('starts a new file with the banner and the entry', () => {
    expect(appendGitignoreEntry(null, '.env.local')).toBe(`${GITIGNORE_BANNER}\n.env.local\n`)
  })

  it('keeps everything already there and separates the new block with a blank line', () => {
    expect(appendGitignoreEntry('node_modules\n', '.env')).toBe(`node_modules\n\n${GITIGNORE_BANNER}\n.env\n`)
    expect(appendGitignoreEntry('dist', '.env')).toBe(`dist\n\n${GITIGNORE_BANNER}\n.env\n`)
  })
})

describe('ensureGitignored (QA N4-16)', () => {
  it('adds the env file to .gitignore in a fresh repository, and git then ignores it', () => {
    git('init', '-q')
    fs.writeFileSync(path.join(dir, '.env.local'), 'VITE_AVSB_SDK_KEY=sdk_production_abc\n')

    const result = ensureGitignored(dir, '.env.local')

    expect(result).toEqual({ outcome: 'added', gitignorePath: path.join(dir, '.gitignore') })
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toContain('.env.local')
    expect(gitIgnoreState(dir, '.env.local')).toBe('ignored')
  })

  it('touches nothing when git already ignores the file', () => {
    git('init', '-q')
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env*\n')

    expect(ensureGitignored(dir, '.env.local')).toEqual({ outcome: 'already-ignored', gitignorePath: null })
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toBe('.env*\n')
  })

  it('touches nothing outside a git repository', () => {
    const result = ensureGitignored(dir, '.env', () => 'no-repo')

    expect(result).toEqual({ outcome: 'no-repo', gitignorePath: null })
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false)
  })

  it('is idempotent: a second run finds the file ignored', () => {
    git('init', '-q')

    ensureGitignored(dir, '.env')
    const second = ensureGitignored(dir, '.env')

    expect(second.outcome).toBe('already-ignored')
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8').match(/^\.env$/gm)).toHaveLength(1)
  })
})
