import { describe, expect, it } from 'vitest'
import { CliError } from './cliError.js'
import { describeProjectSource, resolveProjectRef, type ProjectRefLookups } from './projectRef.js'

function lookups(overrides: Partial<ProjectRefLookups> = {}): ProjectRefLookups {
  return {
    projectManifest: () => null,
    experimentManifest: () => null,
    ...overrides,
  }
}

describe('resolveProjectRef', () => {
  it('takes --project in every form the CLI prints ids in', () => {
    expect(resolveProjectRef({ project: 'PRJ-42' }, lookups()).shortId).toBe(42)
    expect(resolveProjectRef({ project: '42' }, lookups()).shortId).toBe(42)
    expect(
      resolveProjectRef(
        { project: 'https://app.avsb.cloud/projects/42/dashboard' },
        lookups(),
      ).shortId,
    ).toBe(42)
  })

  it('falls back to the project manifest when no flag is passed', () => {
    const ref = resolveProjectRef({}, lookups({ projectManifest: () => ({ projectShortId: 7 }) }))

    expect(ref).toEqual({ shortId: 7, source: 'project-manifest' })
  })

  it('falls back to a cloned experiment manifest, which is what codegen needed', () => {
    const ref = resolveProjectRef(
      {},
      lookups({ experimentManifest: () => ({ projectShortId: 9 }) }),
    )

    expect(ref).toEqual({ shortId: 9, source: 'experiment-manifest' })
  })

  it('prefers the project manifest when both files are present', () => {
    const ref = resolveProjectRef(
      {},
      lookups({
        projectManifest: () => ({ projectShortId: 7 }),
        experimentManifest: () => ({ projectShortId: 9 }),
      }),
    )

    expect(ref.shortId).toBe(7)
  })

  it('prefers the flag over both files', () => {
    const ref = resolveProjectRef(
      { project: '5' },
      lookups({
        projectManifest: () => ({ projectShortId: 7 }),
        experimentManifest: () => ({ projectShortId: 9 }),
      }),
    )

    expect(ref).toEqual({ shortId: 5, source: 'flag' })
  })

  it('refuses an unparseable flag as a usage error, naming what it wanted', () => {
    try {
      resolveProjectRef({ project: 'proj_abc123' }, lookups())
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).code).toBe('cli_usage')
      expect((err as CliError).hints.join(' ')).toContain('--project 42')
    }
  })

  it('explains both ways to name a project when nothing is found', () => {
    try {
      resolveProjectRef({}, lookups())
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).code).toBe('cli_no_project')
      expect((err as CliError).hints.join(' ')).toContain('avsb clone')
    }
  })
})

describe('describeProjectSource', () => {
  it('names the file the project came from, so nobody has to guess', () => {
    expect(describeProjectSource({ shortId: 42, source: 'flag' })).toContain('--project')
    expect(describeProjectSource({ shortId: 42, source: 'project-manifest' })).toContain(
      '.avsb-project.json',
    )
    expect(describeProjectSource({ shortId: 42, source: 'experiment-manifest' })).toContain(
      '.avsb.json',
    )
  })
})
