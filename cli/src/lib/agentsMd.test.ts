import { describe, expect, it } from 'vitest'
import {
  AGENTS_MARKER_END,
  AGENTS_MARKER_START,
  applyAgentsSection,
  describeAgentsWrite,
  renderAgentsSection,
  type AgentsSectionContext,
} from './agentsMd.js'

function context(overrides: Partial<AgentsSectionContext> = {}): AgentsSectionContext {
  return {
    projectShortId: 42,
    environmentKey: 'production',
    sdkKeyEnvVar: 'VITE_AVSB_SDK_KEY',
    sdkPackage: '@avsbhq/react',
    ...overrides,
  }
}

describe('renderAgentsSection', () => {
  it('wraps the section in the markers a re-run looks for', () => {
    const section = renderAgentsSection(context())

    expect(section.startsWith(AGENTS_MARKER_START)).toBe(true)
    expect(section.trimEnd().endsWith(AGENTS_MARKER_END)).toBe(true)
  })

  it('names the project, environment, package and variable it was given', () => {
    const section = renderAgentsSection(context())

    expect(section).toContain('PRJ-42')
    expect(section).toContain('`production`')
    expect(section).toContain('@avsbhq/react')
    expect(section).toContain('VITE_AVSB_SDK_KEY')
  })

  it('falls back to placeholders when nothing local is known', () => {
    const section = renderAgentsSection(
      context({ projectShortId: null, environmentKey: null, sdkKeyEnvVar: null, sdkPackage: null }),
    )

    expect(section).toContain('PRJ-<id>')
    expect(section).toContain('AVSB_SDK_KEY')
    expect(section).toContain('@avsbhq/browser')
  })

  it('uses the four canonical credential names and their real prefixes', () => {
    const section = renderAgentsSection(context())

    expect(section).toContain('Personal access token')
    expect(section).toContain('avsb_pat_')
    expect(section).toContain('Service token')
    expect(section).toContain('avsb_svc_')
    expect(section).toContain('SDK key')
    expect(section).toContain('Snippet key')
  })
})

describe('applyAgentsSection', () => {
  const section = renderAgentsSection(context())

  it('creates the whole file when there is none', () => {
    const result = applyAgentsSection(null, section)

    expect(result.outcome).toBe('created')
    expect(result.content).toBe(section)
  })

  it('appends below what the team already wrote', () => {
    const existing = '# Our repo\n\nRun the tests before pushing.\n'
    const result = applyAgentsSection(existing, section)

    expect(result.outcome).toBe('appended')
    expect(result.content.startsWith(existing)).toBe(true)
    expect(result.content).toContain(AGENTS_MARKER_START)
  })

  it('replaces an older section in place and keeps the text around it', () => {
    const older = renderAgentsSection(context({ projectShortId: 7 }))
    const existing = `# Our repo\n\n${older}\n## House rules\n\nNo force pushes.\n`

    const result = applyAgentsSection(existing, section)

    expect(result.outcome).toBe('replaced')
    expect(result.content).toContain('# Our repo')
    expect(result.content).toContain('No force pushes.')
    expect(result.content).toContain('PRJ-42')
    expect(result.content).not.toContain('PRJ-7')
    // One section, not two: this is what makes the command safe to re-run.
    expect(result.content.split(AGENTS_MARKER_START)).toHaveLength(2)
  })

  it('reports unchanged when the section is already exactly this one', () => {
    const existing = applyAgentsSection('# Our repo\n', section).content
    const again = applyAgentsSection(existing, section)

    expect(again.outcome).toBe('unchanged')
    expect(again.content).toBe(existing)
  })

  it('repairs a half-deleted marker without losing what was written under it', () => {
    const broken = `# Our repo\n\n${AGENTS_MARKER_START}\nsomeone deleted the end marker\n`
    const result = applyAgentsSection(broken, section)

    expect(result.outcome).toBe('repaired')
    expect(result.content).toContain('someone deleted the end marker')
    expect(result.content).toContain('# Our repo')
    expect(result.content.split(AGENTS_MARKER_START)).toHaveLength(2)
  })

  it('does not accumulate copies when a broken file is run through twice', () => {
    // The bug this pins: an orphaned start marker made every run append, so the
    // third run left three sections in the file.
    const broken = `# Our repo\n\n${AGENTS_MARKER_START}\nsomeone deleted the end marker\n`

    const once = applyAgentsSection(broken, section)
    const twice = applyAgentsSection(once.content, section)
    const thrice = applyAgentsSection(twice.content, section)

    expect(twice.outcome).toBe('unchanged')
    expect(thrice.content).toBe(once.content)
    expect(thrice.content.split(AGENTS_MARKER_START)).toHaveLength(2)
    expect(thrice.content.split(AGENTS_MARKER_END)).toHaveLength(2)
  })

  it('repairs markers left in the wrong order', () => {
    const reversed = `# Our repo\n\n${AGENTS_MARKER_END}\nstray text\n${AGENTS_MARKER_START}\n`
    const result = applyAgentsSection(reversed, section)

    expect(result.outcome).toBe('repaired')
    expect(result.content).toContain('stray text')
    expect(result.content.split(AGENTS_MARKER_START)).toHaveLength(2)
    expect(applyAgentsSection(result.content, section).outcome).toBe('unchanged')
  })
})

describe('describeAgentsWrite', () => {
  it('has a distinct line for every outcome', () => {
    expect(describeAgentsWrite('created', '/repo/AGENTS.md')).toContain('Created')
    expect(describeAgentsWrite('replaced', '/repo/AGENTS.md')).toContain('Replaced')
    expect(describeAgentsWrite('appended', '/repo/AGENTS.md')).toContain('Added')
    expect(describeAgentsWrite('repaired', '/repo/AGENTS.md')).toContain('Repaired')
    expect(describeAgentsWrite('unchanged', '/repo/AGENTS.md')).toContain('Left alone')
  })
})
