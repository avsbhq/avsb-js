import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_VERSION, buildOrgCandidates } from '../lib/credentials.js'
import type { AvsbConfig, AvsbSession } from '../types/config.js'

const CONFIG_PATH = '/home/tester/.avsb/config.json'

const mocks = vi.hoisted(() => {
  const spinner = {
    succeed: vi.fn(),
    fail: vi.fn(),
    stop: vi.fn(),
    warn: vi.fn(),
    text: '',
    start: vi.fn(),
  }
  spinner.start.mockReturnValue(spinner)

  return {
    spinner,
    ora: vi.fn(() => spinner),
    prompt: vi.fn(),
    listOrgs: vi.fn(),
    ensureLoggedIn: vi.fn(),
    readConfig: vi.fn(),
    writeConfig: vi.fn(),
    logger: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      dim: vi.fn(),
      heading: vi.fn(),
      label: vi.fn(),
      field: vi.fn(),
      fileTree: vi.fn(),
      errorDetail: vi.fn(),
      line: vi.fn(),
    },
  }
})

vi.mock('ora', () => ({ default: mocks.ora }))
vi.mock('inquirer', () => ({ default: { prompt: mocks.prompt } }))
vi.mock('../lib/logger.js', () => mocks.logger)
vi.mock('../lib/config.js', () => ({
  ensureLoggedIn: mocks.ensureLoggedIn,
  readConfig: mocks.readConfig,
  writeConfig: mocks.writeConfig,
  getConfigPath: () => CONFIG_PATH,
}))
vi.mock('../lib/api.js', () => ({
  ApiClient: class {
    listOrgs = mocks.listOrgs
  },
}))

class ProcessExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

const apiOrgs = [
  { id: 'org-1', shortId: 41, name: 'Acme Corp' },
  { id: 'org-2', shortId: 42, name: 'Beta Inc' },
  { id: 'org-3', shortId: 43, name: 'Gamma Ltd' },
]

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

function session(overrides: Partial<AvsbSession> = {}): AvsbSession {
  return {
    token: 'pat_acme',
    orgId: 'org-1',
    orgName: 'Acme Corp',
    apiBaseUrl: 'https://app.avsb.cloud',
    tokenSource: 'config',
    ...overrides,
  }
}

/** Fresh command per run: commander keeps option values on the instance. */
async function runOrg(argv: string[]): Promise<void> {
  vi.resetModules()
  const { orgCommand } = await import('./org.js')
  await orgCommand.parseAsync(argv, { from: 'user' })
}

function savedConfig(): AvsbConfig {
  const [call] = mocks.writeConfig.mock.calls
  if (!call) throw new Error('writeConfig was not called')
  return call[0] as AvsbConfig
}

describe('describeSwitchFailure', () => {
  it('lists the organizations the token can reach', async () => {
    const { describeSwitchFailure } = await import('./org.js')
    const candidates = buildOrgCandidates(makeConfig(), apiOrgs)

    const message = describeSwitchFailure(candidates, 'typo')

    expect(message).toContain('No organization matches "typo"')
    expect(message).toContain('41 (Acme Corp)')
    expect(message).toContain('43 (Gamma Ltd)')
  })

  it('says so plainly when the token reaches nothing', async () => {
    const { describeSwitchFailure } = await import('./org.js')

    expect(describeSwitchFailure([], 'anything')).toContain(
      'cannot reach any organization',
    )
  })
})

describe('avsb org switch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.spinner.start.mockReturnValue(mocks.spinner)
    mocks.ensureLoggedIn.mockReturnValue(session())
    mocks.readConfig.mockReturnValue({ status: 'ok', config: makeConfig() })
    mocks.listOrgs.mockResolvedValue({ data: apiOrgs })
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ProcessExitError(typeof code === 'number' ? code : 0)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('switches by short id and persists the choice', async () => {
    await runOrg(['switch', '42'])

    expect(savedConfig().activeOrgId).toBe('org-2')
    expect(mocks.logger.success).toHaveBeenCalledWith('Switched to Beta Inc.')
  })

  it('switches by name and saves a login using the current token', async () => {
    await runOrg(['switch', 'gamma ltd'])

    const config = savedConfig()
    expect(config.activeOrgId).toBe('org-3')
    expect(config.logins).toContainEqual({
      orgId: 'org-3',
      orgName: 'Gamma Ltd',
      token: 'pat_acme',
    })
  })

  it('keeps the existing token when the target organization already has one', async () => {
    // 'org-2' would read as the documented ORG-<shortId> selector (short id 2,
    // matching nothing); the name form keeps this test about token reuse.
    await runOrg(['switch', 'beta inc'])

    expect(savedConfig().logins).toContainEqual({
      orgId: 'org-2',
      orgName: 'Beta Inc',
      token: 'pat_beta',
    })
  })

  it('writes nothing when the target is already active', async () => {
    await runOrg(['switch', '41'])

    expect(mocks.writeConfig).not.toHaveBeenCalled()
    expect(mocks.logger.info).toHaveBeenCalledWith('Already using Acme Corp.')
  })

  it('fails with the list of options when the argument matches nothing', async () => {
    await expect(runOrg(['switch', 'nope'])).rejects.toThrow(ProcessExitError)

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('No organization matches "nope"'),
    )
    expect(mocks.writeConfig).not.toHaveBeenCalled()
  })

  it('refuses to prompt under --no-input', async () => {
    await expect(runOrg(['switch', '--no-input'])).rejects.toThrow(ProcessExitError)

    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('avsb org switch <short id | id | name>'),
    )
  })

  it('prompts with the reachable organizations when no argument is given in a terminal', async () => {
    const original = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    mocks.prompt.mockResolvedValue({ chosen: 'org-3' })

    try {
      await runOrg(['switch'])
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true })
    }

    expect(mocks.prompt).toHaveBeenCalledTimes(1)
    expect(savedConfig().activeOrgId).toBe('org-3')
  })

  // QA N4-15: with no terminal the prompt ended in a raw Node warning and
  // "User force closed the prompt".
  it('names the argument and the choices instead of prompting without a terminal', async () => {
    const original = process.stdin.isTTY
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })

    try {
      await expect(runOrg(['switch'])).rejects.toThrow(ProcessExitError)
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true })
    }

    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('avsb org switch <short id | id | name>'))
    expect(mocks.logger.errorDetail).toHaveBeenCalledWith('Available: 41 (Acme Corp), 42 (Beta Inc), 43 (Gamma Ltd).')
  })

  it('points at `avsb login` when there is no saved config to change', async () => {
    mocks.readConfig.mockReturnValue({ status: 'missing' })
    mocks.ensureLoggedIn.mockReturnValue(
      session({ orgId: '', orgName: '', tokenSource: 'env' }),
    )

    await expect(runOrg(['switch', '42'])).rejects.toThrow(ProcessExitError)

    // failCommand routes the headline to error() and the hint to errorDetail().
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Nothing to switch'),
    )
    expect(mocks.logger.errorDetail).toHaveBeenCalledWith(
      expect.stringContaining('Run `avsb login` first'),
    )
    expect(mocks.writeConfig).not.toHaveBeenCalled()
  })

  it('warns that AVSB_TOKEN still decides the account after switching', async () => {
    mocks.ensureLoggedIn.mockReturnValue(session({ tokenSource: 'env' }))

    await runOrg(['switch', '42'])

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AVSB_TOKEN is set'),
    )
  })
})

describe('avsb org list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.spinner.start.mockReturnValue(mocks.spinner)
    mocks.ensureLoggedIn.mockReturnValue(session())
    mocks.readConfig.mockReturnValue({ status: 'ok', config: makeConfig() })
    mocks.listOrgs.mockResolvedValue({ data: apiOrgs })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ProcessExitError(typeof code === 'number' ? code : 0)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints one row per organization the token reaches', async () => {
    await runOrg(['list'])

    const printed = mocks.logger.line.mock.calls.map((call) => String(call[0] ?? '')).join('\n')
    expect(printed).toContain('Acme Corp')
    expect(printed).toContain('Beta Inc')
    expect(printed).toContain('Gamma Ltd')
  })

  it('flags organizations that are only known from a saved login', async () => {
    mocks.readConfig.mockReturnValue({
      status: 'ok',
      config: makeConfig({
        logins: [
          { orgId: 'org-1', orgName: 'Acme Corp', token: 'pat_acme' },
          { orgId: 'org-x', orgName: 'Other Account Org', token: 'pat_other' },
        ],
      }),
    })

    await runOrg(['list'])

    const printed = mocks.logger.line.mock.calls.map((call) => String(call[0] ?? '')).join('\n')
    expect(printed).toContain('Other Account Org')
    expect(mocks.logger.dim).toHaveBeenCalledWith(
      expect.stringContaining('saved from another token'),
    )
  })

  it('says so when the token reaches no organizations', async () => {
    mocks.listOrgs.mockResolvedValue({ data: [] })
    mocks.readConfig.mockReturnValue({ status: 'missing' })

    await runOrg(['list'])

    expect(mocks.logger.warn).toHaveBeenCalledWith('No organizations found for this token.')
  })

  // QA N4-8: `org` declares --json too, and commander gave the flag typed
  // after `list` to the parent, so the table printed instead of JSON.
  it.each([
    [['list', '--json']],
    [['--json', 'list']],
  ])('prints one JSON document and no table for %j', async (argv) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    await runOrg(argv)

    const printed = stdout.mock.calls.map((call) => String(call[0])).join('')
    const envelope = JSON.parse(printed) as { ok: boolean; command: string; data: Array<{ name: string }> }
    expect(envelope.ok).toBe(true)
    expect(envelope.command).toBe('org list')
    expect(envelope.data.map((org) => org.name)).toEqual(['Acme Corp', 'Beta Inc', 'Gamma Ltd'])
    expect(mocks.logger.heading).not.toHaveBeenCalled()
  })

  it('drops the heading under --quiet typed after list, and keeps the rows', async () => {
    const { resetOutputMode } = await import('../lib/outputMode.js')
    resetOutputMode()

    await runOrg(['list', '--quiet'])

    const { isQuiet } = await import('../lib/outputMode.js')
    expect(isQuiet()).toBe(true)
    resetOutputMode()
  })
})
