import { describe, expect, it } from 'vitest'
import { CliError } from '../lib/cliError.js'
import { browserCommand, OPEN_TARGETS, resolveOpenTarget } from './open.js'
import type { ProjectRef } from '../lib/projectRef.js'

const BASE = 'https://app.avsb.cloud'
const project = (): ProjectRef => ({ shortId: 42, source: 'flag' })

describe('resolveOpenTarget', () => {
  it('defaults to the project dashboard', () => {
    expect(resolveOpenTarget(undefined, BASE, project).url).toBe(
      'https://app.avsb.cloud/projects/42/dashboard',
    )
  })

  it('opens an experiment by the id the CLI prints', () => {
    const resolved = resolveOpenTarget('EXP-7', BASE, project)

    expect(resolved.url).toBe('https://app.avsb.cloud/projects/42/experiments/7')
    expect(resolved.label).toContain('EXP-7')
  })

  it('opens a project by id without needing a local manifest', () => {
    const resolved = resolveOpenTarget('PRJ-9', BASE, () => {
      throw new Error('should not need the project lookup')
    })

    expect(resolved.url).toBe('https://app.avsb.cloud/projects/9/dashboard')
  })

  it('sends datasets to the commerce section, where the page actually lives', () => {
    expect(resolveOpenTarget('datasets', BASE, project).url).toBe(
      'https://app.avsb.cloud/projects/42/commerce/datasets',
    )
  })

  it('sends snippet and environments to the tabs that hold the install keys', () => {
    expect(resolveOpenTarget('snippet', BASE, project).url).toBe(
      'https://app.avsb.cloud/projects/42/settings?tab=snippet',
    )
    expect(resolveOpenTarget('environments', BASE, project).url).toBe(
      'https://app.avsb.cloud/projects/42/environments',
    )
  })

  it('opens account-level pages without asking for a project', () => {
    const noProject = (): ProjectRef => {
      throw new Error('should not need the project lookup')
    }

    expect(resolveOpenTarget('tokens', BASE, noProject).url).toBe(
      'https://app.avsb.cloud/account?tab=tokens',
    )
    expect(resolveOpenTarget('docs', BASE, noProject).url).toContain('/docs/developer-reference/cli-tool')
  })

  it('follows the base URL it is given, so a local run does not open production', () => {
    expect(resolveOpenTarget('flags', 'http://localhost:3000', project).url).toBe(
      'http://localhost:3000/projects/42/flags',
    )
  })

  it('lists what it can open when asked for something it cannot', () => {
    try {
      resolveOpenTarget('billing', BASE, project)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).code).toBe('cli_usage')
      expect((err as CliError).hints.join(' ')).toContain('dashboard')
    }
  })

  it('resolves every advertised target, so help text cannot promise a broken link', () => {
    for (const target of OPEN_TARGETS) {
      expect(resolveOpenTarget(target, BASE, project).url.startsWith(BASE)).toBe(true)
    }
  })
})

describe('browserCommand', () => {
  it('uses the platform opener', () => {
    expect(browserCommand('darwin').command).toBe('open')
    expect(browserCommand('win32')).toEqual({ command: 'cmd', args: ['/c', 'start', ''] })
    expect(browserCommand('linux').command).toBe('xdg-open')
  })
})
