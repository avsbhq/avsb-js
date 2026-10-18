import { describe, expect, it } from 'vitest'
import { CliError } from '../lib/cliError.js'
import { chooseTargets, readProjectShortId } from './agents-md.js'

describe('chooseTargets', () => {
  it('writes both conventions when neither flag narrows it', () => {
    expect(chooseTargets({})).toEqual(['CLAUDE.md', 'AGENTS.md'])
  })

  it('narrows to one file when asked', () => {
    expect(chooseTargets({ claude: true })).toEqual(['CLAUDE.md'])
    expect(chooseTargets({ agents: true })).toEqual(['AGENTS.md'])
  })

  it('writes both when both flags are passed', () => {
    expect(chooseTargets({ claude: true, agents: true })).toEqual(['CLAUDE.md', 'AGENTS.md'])
  })
})

describe('readProjectShortId', () => {
  it('accepts every form the CLI prints project ids in', () => {
    expect(readProjectShortId('PRJ-42')).toBe(42)
    expect(readProjectShortId('42')).toBe(42)
    expect(readProjectShortId('https://app.avsb.cloud/projects/42/flags')).toBe(42)
  })

  it('returns null when no project was named, because the section still works', () => {
    expect(readProjectShortId(undefined)).toBeNull()
  })

  it('refuses an unparseable value as a usage error', () => {
    expect(() => readProjectShortId('proj_abc123')).toThrow(CliError)
  })
})
