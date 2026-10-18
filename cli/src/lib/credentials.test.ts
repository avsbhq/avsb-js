import { describe, expect, it } from 'vitest'
import {
  CONFIG_VERSION,
  activateOrg,
  buildOrgCandidates,
  describeTokenSource,
  findLogin,
  matchOrgCandidate,
  parseConfigDocument,
  resolveSession,
  upsertLogin,
  type ConfigReadResult,
} from './credentials.js'
import { DEFAULT_API_BASE_URL } from './env.js'
import type { AvsbConfig, AvsbSession } from '../types/config.js'

const CONFIG_PATH = '/home/tester/.avsb/config.json'

function makeConfig(overrides: Partial<AvsbConfig> = {}): AvsbConfig {
  return {
    version: CONFIG_VERSION,
    activeOrgId: 'org-1',
    logins: [
      { orgId: 'org-1', orgName: 'Acme Corp', token: 'pat_acme' },
      { orgId: 'org-2', orgName: 'Beta Inc', token: 'pat_beta' },
    ],
    apiBaseUrl: 'https://app.avsb.cloud',
    ...overrides,
  }
}

function ok(config: AvsbConfig): ConfigReadResult {
  return { status: 'ok', config }
}

const noEnv = { token: null, apiBaseUrl: null }

// ── parseConfigDocument ─────────────────────────────────────

describe('parseConfigDocument', () => {
  it('accepts a current config file', () => {
    const result = parseConfigDocument(JSON.stringify(makeConfig()))

    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.config.logins).toHaveLength(2)
    expect(result.config.activeOrgId).toBe('org-1')
  })

  it('reports invalid JSON instead of throwing', () => {
    const result = parseConfigDocument('{not json')

    expect(result).toEqual({ status: 'unreadable', detail: 'it is not valid JSON' })
  })

  it('reports a file written by an older CLI (no version field)', () => {
    const legacy = JSON.stringify({
      token: 'pat_old',
      orgId: 'org-1',
      orgName: 'Acme Corp',
      apiBaseUrl: 'https://app.avsb.cloud',
      defaults: { script: 'js', style: 'css' },
    })

    const result = parseConfigDocument(legacy)

    expect(result).toEqual({
      status: 'unreadable',
      detail: 'it was written by an older version of the CLI',
    })
  })

  it('reports an unsupported future version by number', () => {
    const result = parseConfigDocument(JSON.stringify({ version: 99, logins: [] }))

    expect(result.status).toBe('unreadable')
    if (result.status !== 'unreadable') throw new Error('expected unreadable')
    expect(result.detail).toContain('version 99')
  })

  it('rejects a login entry that is missing its token', () => {
    const raw = JSON.stringify({
      version: CONFIG_VERSION,
      activeOrgId: 'org-1',
      apiBaseUrl: 'https://app.avsb.cloud',
      logins: [{ orgId: 'org-1', orgName: 'Acme Corp' }],
    })

    expect(parseConfigDocument(raw)).toEqual({
      status: 'unreadable',
      detail: 'one of its saved logins is incomplete',
    })
  })

  it('rejects a config with an empty login list', () => {
    const raw = JSON.stringify({ version: CONFIG_VERSION, activeOrgId: '', logins: [] })

    expect(parseConfigDocument(raw)).toEqual({
      status: 'unreadable',
      detail: 'it has no saved logins',
    })
  })

  it('falls back to the default base URL when the file omits one', () => {
    const raw = JSON.stringify({
      version: CONFIG_VERSION,
      activeOrgId: 'org-1',
      logins: [{ orgId: 'org-1', orgName: 'Acme Corp', token: 'pat_acme' }],
    })

    const result = parseConfigDocument(raw)

    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.config.apiBaseUrl).toBe(DEFAULT_API_BASE_URL)
  })
})

// ── resolveSession (the documented precedence) ───────────────

describe('resolveSession', () => {
  it('uses the active saved login when no environment variables are set', () => {
    const result = resolveSession(ok(makeConfig()), noEnv)

    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.session).toEqual({
      token: 'pat_acme',
      orgId: 'org-1',
      orgName: 'Acme Corp',
      apiBaseUrl: 'https://app.avsb.cloud',
      tokenSource: 'config',
    })
    expect(result.warning).toBeUndefined()
  })

  it('lets AVSB_TOKEN win over the saved token', () => {
    const result = resolveSession(ok(makeConfig()), {
      token: 'pat_from_env',
      apiBaseUrl: null,
    })

    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.session.token).toBe('pat_from_env')
    expect(result.session.tokenSource).toBe('env')
    // Organization labels still come from the saved login.
    expect(result.session.orgName).toBe('Acme Corp')
  })

  it('lets AVSB_API_URL win over the saved base URL', () => {
    const result = resolveSession(ok(makeConfig()), {
      token: null,
      apiBaseUrl: 'http://localhost:3000',
    })

    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.session.apiBaseUrl).toBe('http://localhost:3000')
  })

  it('works with no config file at all when AVSB_TOKEN is set', () => {
    const result = resolveSession({ status: 'missing' }, {
      token: 'pat_from_env',
      apiBaseUrl: null,
    })

    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.session).toEqual({
      token: 'pat_from_env',
      orgId: '',
      orgName: '',
      apiBaseUrl: DEFAULT_API_BASE_URL,
      tokenSource: 'env',
    })
  })

  it('still authenticates from the environment when the config file is unusable', () => {
    const result = resolveSession(
      { status: 'unreadable', detail: 'it is not valid JSON' },
      { token: 'pat_from_env', apiBaseUrl: null },
    )

    expect(result.status).toBe('ok')
  })

  it('reports no credentials when there is neither a config file nor a token', () => {
    expect(resolveSession({ status: 'missing' }, noEnv)).toEqual({
      status: 'no-credentials',
    })
  })

  it('passes the unreadable reason through when nothing else can authenticate', () => {
    expect(
      resolveSession({ status: 'unreadable', detail: 'it has no saved logins' }, noEnv),
    ).toEqual({ status: 'unreadable', detail: 'it has no saved logins' })
  })

  it('falls back to the first login and warns when the active org is missing', () => {
    const result = resolveSession(ok(makeConfig({ activeOrgId: 'org-gone' })), noEnv)

    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.session.orgId).toBe('org-1')
    expect(result.warning).toContain('Acme Corp')
  })
})

// ── upsertLogin / findLogin ─────────────────────────────────

describe('upsertLogin', () => {
  it('creates the first login and makes it active', () => {
    const config = upsertLogin(
      null,
      { orgId: 'org-1', orgName: 'Acme Corp', token: 'pat_acme' },
      'https://app.avsb.cloud/',
    )

    expect(config).toEqual({
      version: CONFIG_VERSION,
      activeOrgId: 'org-1',
      logins: [{ orgId: 'org-1', orgName: 'Acme Corp', token: 'pat_acme' }],
      apiBaseUrl: 'https://app.avsb.cloud',
    })
  })

  it('adds a second organization without dropping the first', () => {
    const config = upsertLogin(
      makeConfig({ logins: [{ orgId: 'org-1', orgName: 'Acme Corp', token: 'pat_acme' }] }),
      { orgId: 'org-2', orgName: 'Beta Inc', token: 'pat_beta' },
      'https://app.avsb.cloud',
    )

    expect(config.logins.map((login) => login.orgId)).toEqual(['org-1', 'org-2'])
    expect(config.activeOrgId).toBe('org-2')
  })

  it('replaces a token in place, keeping list order stable', () => {
    const config = upsertLogin(
      makeConfig(),
      { orgId: 'org-1', orgName: 'Acme Corp', token: 'pat_rotated' },
      'https://app.avsb.cloud',
    )

    expect(config.logins.map((login) => login.orgId)).toEqual(['org-1', 'org-2'])
    expect(findLogin(config, 'org-1')?.token).toBe('pat_rotated')
    expect(config.logins).toHaveLength(2)
  })
})

// ── org candidates, matching, switching ─────────────────────

const apiOrgs = [
  { id: 'org-1', shortId: 41, name: 'Acme Corp' },
  { id: 'org-2', shortId: 42, name: 'Beta Inc' },
  { id: 'org-3', shortId: 43, name: 'Gamma Ltd' },
]

describe('buildOrgCandidates', () => {
  it('marks the active organization and the ones with saved tokens', () => {
    const candidates = buildOrgCandidates(makeConfig(), apiOrgs)

    expect(candidates.map((c) => [c.id, c.saved, c.active])).toEqual([
      ['org-1', true, true],
      ['org-2', true, false],
      ['org-3', false, false],
    ])
  })

  it('keeps organizations that only exist as a saved login, with no short id', () => {
    const config = makeConfig({
      logins: [
        { orgId: 'org-1', orgName: 'Acme Corp', token: 'pat_acme' },
        { orgId: 'org-other', orgName: 'Other Account Org', token: 'pat_other' },
      ],
    })

    const candidates = buildOrgCandidates(config, apiOrgs)
    const savedOnly = candidates.find((c) => c.id === 'org-other')

    expect(savedOnly).toEqual({
      id: 'org-other',
      shortId: null,
      name: 'Other Account Org',
      saved: true,
      active: false,
    })
  })

  it('marks nothing active when the environment supplied the token', () => {
    const candidates = buildOrgCandidates(
      { version: CONFIG_VERSION, activeOrgId: '', logins: [], apiBaseUrl: 'https://x' },
      apiOrgs,
    )

    expect(candidates.every((c) => !c.active && !c.saved)).toBe(true)
  })
})

describe('matchOrgCandidate', () => {
  const candidates = buildOrgCandidates(makeConfig(), apiOrgs)

  it('matches a numeric short id', () => {
    expect(matchOrgCandidate(candidates, '42')?.id).toBe('org-2')
  })

  it('matches an ORG-prefixed short id case-insensitively', () => {
    expect(matchOrgCandidate(candidates, 'org-43')?.id).toBe('org-3')
    expect(matchOrgCandidate(candidates, 'ORG-43')?.id).toBe('org-3')
  })

  it('matches an organization id', () => {
    // Real org ids are cuids. `org-1` cannot stand in for one here: `ORG-<short
    // id>` is the documented public form and wins, so `org-1` reads as short id
    // 1, not as the id that happens to be spelled that way in this fixture.
    const cuidCandidates = buildOrgCandidates(makeConfig(), [
      { id: 'clx0delta444444444444444', shortId: 44, name: 'Delta LLC' },
    ])

    expect(matchOrgCandidate(cuidCandidates, 'clx0delta444444444444444')?.id).toBe(
      'clx0delta444444444444444',
    )
  })

  it('matches a name regardless of case and surrounding spaces', () => {
    expect(matchOrgCandidate(candidates, '  beta inc ')?.id).toBe('org-2')
  })

  it('returns null for an unknown value and for an empty string', () => {
    expect(matchOrgCandidate(candidates, 'nope')).toBeNull()
    expect(matchOrgCandidate(candidates, '   ')).toBeNull()
  })
})

describe('activateOrg', () => {
  it('switches to an organization that already has a saved token, keeping it', () => {
    const config = makeConfig()
    const target = buildOrgCandidates(config, apiOrgs).find((c) => c.id === 'org-2')
    if (!target) throw new Error('expected candidate')

    const next = activateOrg(config, target, 'pat_acme')

    expect(next.activeOrgId).toBe('org-2')
    expect(findLogin(next, 'org-2')?.token).toBe('pat_beta')
    expect(next.logins).toHaveLength(2)
  })

  it('saves a login for an organization reached with the current token', () => {
    const config = makeConfig()
    const target = buildOrgCandidates(config, apiOrgs).find((c) => c.id === 'org-3')
    if (!target) throw new Error('expected candidate')

    const next = activateOrg(config, target, 'pat_acme')

    expect(next.activeOrgId).toBe('org-3')
    expect(findLogin(next, 'org-3')).toEqual({
      orgId: 'org-3',
      orgName: 'Gamma Ltd',
      token: 'pat_acme',
    })
  })

  it('leaves the base URL alone', () => {
    const config = makeConfig({ apiBaseUrl: 'http://localhost:3000' })
    const target = buildOrgCandidates(config, apiOrgs).find((c) => c.id === 'org-3')
    if (!target) throw new Error('expected candidate')

    expect(activateOrg(config, target, 'pat_acme').apiBaseUrl).toBe('http://localhost:3000')
  })
})

describe('describeTokenSource', () => {
  const session: AvsbSession = {
    token: 'pat_acme',
    orgId: 'org-1',
    orgName: 'Acme Corp',
    apiBaseUrl: 'https://app.avsb.cloud',
    tokenSource: 'config',
  }

  it('names the config file for a saved login', () => {
    expect(describeTokenSource(session, CONFIG_PATH)).toBe(CONFIG_PATH)
  })

  it('names the environment variable when that is where the token came from', () => {
    expect(describeTokenSource({ ...session, tokenSource: 'env' }, CONFIG_PATH)).toBe(
      'AVSB_TOKEN environment variable',
    )
  })
})
