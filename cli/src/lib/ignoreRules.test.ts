import { describe, expect, it } from 'vitest'
import { isIgnored, parseIgnoreFile } from './ignoreRules.js'

function ignored(patterns: string, relPath: string, isDirectory = false, base = ''): boolean {
  return isIgnored(relPath, isDirectory, parseIgnoreFile(patterns, base))
}

describe('parseIgnoreFile', () => {
  it('skips blank lines and comments', () => {
    expect(parseIgnoreFile('\n# a comment\n\n')).toEqual([])
  })

  it('records negation and directory-only flags', () => {
    const rules = parseIgnoreFile('build/\n!build/keep.ts\n')
    expect(rules.map((r) => [r.negated, r.directoryOnly])).toEqual([
      [false, true],
      [true, false],
    ])
  })
})

describe('isIgnored — matching', () => {
  it('matches a bare name at any depth', () => {
    expect(ignored('secrets.ts', 'secrets.ts')).toBe(true)
    expect(ignored('secrets.ts', 'src/deep/secrets.ts')).toBe(true)
  })

  it('anchors a pattern that contains a slash', () => {
    expect(ignored('src/secrets.ts', 'src/secrets.ts')).toBe(true)
    expect(ignored('src/secrets.ts', 'app/src/secrets.ts')).toBe(false)
  })

  it('anchors a pattern with a leading slash', () => {
    expect(ignored('/build', 'build')).toBe(true)
    expect(ignored('/build', 'packages/build')).toBe(false)
  })

  it('covers everything inside a matched directory', () => {
    expect(ignored('build', 'build/app/main.js')).toBe(true)
  })

  it('applies a directory-only pattern to directories, not to a like-named file', () => {
    expect(ignored('build/', 'build', true)).toBe(true)
    expect(ignored('build/', 'build', false)).toBe(false)
  })

  it('expands * without crossing a directory boundary', () => {
    expect(ignored('*.log', 'debug.log')).toBe(true)
    expect(ignored('*.log', 'logs/debug.log')).toBe(true)
    expect(ignored('src/*.ts', 'src/a.ts')).toBe(true)
    expect(ignored('src/*.ts', 'src/deep/a.ts')).toBe(false)
  })

  it('expands ** across directories', () => {
    expect(ignored('src/**/generated', 'src/a/b/generated', true)).toBe(true)
    expect(ignored('**/fixtures', 'a/fixtures', true)).toBe(true)
  })

  it('expands ? to exactly one character', () => {
    expect(ignored('a?.ts', 'ab.ts')).toBe(true)
    expect(ignored('a?.ts', 'abc.ts')).toBe(false)
  })

  it('supports character classes, including negated ones', () => {
    expect(ignored('a[0-9].ts', 'a4.ts')).toBe(true)
    expect(ignored('a[0-9].ts', 'ax.ts')).toBe(false)
    expect(ignored('a[!0-9].ts', 'ax.ts')).toBe(true)
  })

  it('treats a regex metacharacter in a pattern as a literal', () => {
    expect(ignored('a+b.ts', 'a+b.ts')).toBe(true)
    expect(ignored('a+b.ts', 'aab.ts')).toBe(false)
  })
})

describe('isIgnored — precedence', () => {
  it('lets a later negation win, which is what !keep-me is for', () => {
    expect(ignored('*.ts\n!keep.ts\n', 'keep.ts')).toBe(false)
    expect(ignored('*.ts\n!keep.ts\n', 'drop.ts')).toBe(true)
  })

  it('lets a later ignore win over an earlier negation', () => {
    expect(ignored('!keep.ts\n*.ts\n', 'keep.ts')).toBe(true)
  })

  it('ignores nothing when no rule matches', () => {
    expect(ignored('build/\n*.log\n', 'src/main.ts')).toBe(false)
  })
})

describe('isIgnored — nested ignore files', () => {
  it('only governs the subtree the ignore file sits in', () => {
    expect(ignored('secrets.ts', 'packages/app/secrets.ts', false, 'packages/app')).toBe(true)
    expect(ignored('secrets.ts', 'packages/other/secrets.ts', false, 'packages/app')).toBe(false)
    expect(ignored('secrets.ts', 'secrets.ts', false, 'packages/app')).toBe(false)
  })

  it('anchors a slashed pattern to its own directory, not the repository root', () => {
    expect(ignored('src/gen.ts', 'packages/app/src/gen.ts', false, 'packages/app')).toBe(true)
    expect(ignored('src/gen.ts', 'src/gen.ts', false, 'packages/app')).toBe(false)
  })
})
