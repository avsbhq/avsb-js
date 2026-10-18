import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONFIG_VERSION } from '../lib/credentials.js'
import type { AvsbConfig } from '../types/config.js'

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
    verifyAuth: vi.fn(),
    apiCtor: vi.fn(),
    readConfig: vi.fn(),
    writeConfig: vi.fn(),
    readPipedStdin: vi.fn(),
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
  readConfig: mocks.readConfig,
  writeConfig: mocks.writeConfig,
  getConfigPath: () => CONFIG_PATH,
}))
vi.mock('../lib/interactive.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/interactive.js')>()),
  readPipedStdin: mocks.readPipedStdin,
}))
vi.mock('../lib/api.js', () => ({
  ApiClient: class {
    verifyAuth = mocks.verifyAuth
    constructor(config: unknown, options?: unknown) {
      mocks.apiCtor(config, options)
    }
  },
}))

class ProcessExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

/**
 * A fresh command per test: commander keeps option values (including defaults)
 * on the instance, and the `--url` default is read from the environment at
 * import time.
 */
const ORIGINAL_IS_TTY = process.stdin.isTTY

/** Pretend stdin is (or is not) a terminal; restored after each test. */
function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

async function runLogin(argv: string[]): Promise<void> {
  vi.resetModules()
  const { loginCommand } = await import('./login.js')
  await loginCommand.parseAsync(argv, { from: 'user' })
}

function verifiedAs(email: string, orgId: string, orgName: string): void {
  mocks.verifyAuth.mockResolvedValue({
    data: { email, orgId, orgName, role: 'DEVELOPER' },
  })
}

function savedConfig(): AvsbConfig {
  const [call] = mocks.writeConfig.mock.calls
  if (!call) throw new Error('writeConfig was not called')
  return call[0] as AvsbConfig
}

describe('avsb login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.spinner.start.mockReturnValue(mocks.spinner)
    mocks.readConfig.mockReturnValue({ status: 'missing' })
    verifiedAs('dev@example.com', 'org-1', 'Acme Corp')
    delete process.env.AVSB_TOKEN
    delete process.env.AVSB_API_URL
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ProcessExitError(typeof code === 'number' ? code : 0)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(process.stdin, 'isTTY', { value: ORIGINAL_IS_TTY, configurable: true })
    delete process.env.AVSB_TOKEN
    delete process.env.AVSB_API_URL
  })

  it('saves the token from --token without prompting for anything', async () => {
    await runLogin(['--token', 'pat_new', '--no-input'])

    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(savedConfig()).toEqual({
      version: CONFIG_VERSION,
      activeOrgId: 'org-1',
      logins: [{ orgId: 'org-1', orgName: 'Acme Corp', token: 'pat_new' }],
      apiBaseUrl: 'https://app.avsb.cloud',
    })
    expect(mocks.logger.success).toHaveBeenCalledWith(
      'Logged in to Acme Corp as dev@example.com',
    )
  })

  it('verifies the token from --token, ignoring the environment', async () => {
    process.env.AVSB_TOKEN = 'pat_from_env'

    await runLogin(['--token', 'pat_typed', '--no-input'])

    expect(mocks.apiCtor).toHaveBeenCalledWith(
      { token: 'pat_typed', apiBaseUrl: 'https://app.avsb.cloud' },
      { useEnvOverrides: false },
    )
    expect(savedConfig().logins[0].token).toBe('pat_typed')
    // The environment still wins for every other command, so say so.
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('AVSB_TOKEN is set'),
    )
  })

  it('uses AVSB_TOKEN when --token is absent, with no prompt', async () => {
    process.env.AVSB_TOKEN = 'pat_from_env'

    await runLogin(['--no-input'])

    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(savedConfig().logins[0].token).toBe('pat_from_env')
    expect(mocks.logger.warn).not.toHaveBeenCalled()
  })

  it('fails with an actionable message when --no-input has no token to use', async () => {
    await expect(runLogin(['--no-input'])).rejects.toThrow(ProcessExitError)

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Pass --token <token> or set AVSB_TOKEN'),
    )
    expect(mocks.writeConfig).not.toHaveBeenCalled()
  })

  it('prompts for the token in a terminal and trims what is pasted', async () => {
    setTty(true)
    mocks.prompt.mockResolvedValue({ token: '  pat_pasted \n' })

    await runLogin([])

    expect(mocks.prompt).toHaveBeenCalledTimes(1)
    expect(savedConfig().logins[0].token).toBe('pat_pasted')
  })

  // QA N4-14 / N4-15: a piped token went through the masked prompt (one redraw
  // line per character in the log), and a run with no terminal asked anyway.
  it('reads a piped token from stdin, with no prompt at all', async () => {
    setTty(false)
    mocks.readPipedStdin.mockResolvedValue('avsb_pat_piped\n')

    await runLogin([])

    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(savedConfig().logins[0].token).toBe('avsb_pat_piped')
  })

  it('refuses with the three ways to pass a token when nothing is piped and there is no terminal', async () => {
    setTty(false)
    mocks.readPipedStdin.mockResolvedValue('')

    await expect(runLogin([])).rejects.toThrow(ProcessExitError)

    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(mocks.logger.errorDetail).toHaveBeenCalledWith(expect.stringContaining('echo "$TOKEN" | avsb login'))
    expect(mocks.writeConfig).not.toHaveBeenCalled()
  })

  it('does not ask the re-login question without a terminal when a login is already saved', async () => {
    setTty(false)
    mocks.readPipedStdin.mockResolvedValue('avsb_pat_second')
    mocks.readConfig.mockReturnValue({
      status: 'ok',
      config: {
        version: CONFIG_VERSION,
        activeOrgId: 'org-1',
        logins: [{ orgId: 'org-1', orgName: 'Acme Corp', token: 'avsb_pat_first' }],
        apiBaseUrl: 'https://app.avsb.cloud',
      },
    })

    await runLogin([])

    expect(mocks.prompt).not.toHaveBeenCalled()
    expect(mocks.writeConfig).toHaveBeenCalled()
  })

  it('adds a second organization instead of replacing the first', async () => {
    mocks.readConfig.mockReturnValue({
      status: 'ok',
      config: {
        version: CONFIG_VERSION,
        activeOrgId: 'org-1',
        logins: [{ orgId: 'org-1', orgName: 'Acme Corp', token: 'pat_acme' }],
        apiBaseUrl: 'https://app.avsb.cloud',
      },
    })
    verifiedAs('dev@example.com', 'org-2', 'Beta Inc')

    await runLogin(['--token', 'pat_beta', '--no-input'])

    const config = savedConfig()
    expect(config.logins).toEqual([
      { orgId: 'org-1', orgName: 'Acme Corp', token: 'pat_acme' },
      { orgId: 'org-2', orgName: 'Beta Inc', token: 'pat_beta' },
    ])
    expect(config.activeOrgId).toBe('org-2')
  })

  it('saves nothing when the platform rejects the token', async () => {
    // What the transport really throws for a refused token: a 401. Built at
    // call time, from the module instance login.js imported after the reset.
    mocks.verifyAuth.mockImplementation(async () => {
      const { ApiRequestError } = await import('../lib/apiError.js')
      throw new ApiRequestError({ status: 401, message: 'Invalid token' })
    })

    await expect(runLogin(['--token', 'pat_bad', '--no-input'])).rejects.toThrow(
      ProcessExitError,
    )

    expect(mocks.spinner.fail).toHaveBeenCalledWith('Token rejected')
    expect(mocks.logger.error).toHaveBeenCalledWith('Invalid token')
    expect(mocks.writeConfig).not.toHaveBeenCalled()
  })

  // QA N4-10: a host that does not resolve was reported as "Token rejected".
  it('does not blame the token when the platform could not be reached', async () => {
    mocks.verifyAuth.mockImplementation(async () => {
      const { CliError } = await import('../lib/cliError.js')
      throw new CliError('cli_network', 'Cannot find app.avsb.invalid: the name does not resolve (DNS lookup failed).')
    })

    await expect(runLogin(['--token', 'avsb_pat_good', '--no-input'])).rejects.toThrow(ProcessExitError)

    expect(mocks.spinner.fail).toHaveBeenCalledWith('Could not check the token')
    expect(mocks.spinner.fail).not.toHaveBeenCalledWith('Token rejected')
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('app.avsb.invalid'))
    expect(mocks.writeConfig).not.toHaveBeenCalled()
  })

  it('honours --url for the verification call and the saved base URL', async () => {
    await runLogin(['--token', 'pat_new', '--no-input', '--url', 'http://localhost:3000/'])

    expect(mocks.apiCtor).toHaveBeenCalledWith(
      { token: 'pat_new', apiBaseUrl: 'http://localhost:3000' },
      { useEnvOverrides: false },
    )
    expect(savedConfig().apiBaseUrl).toBe('http://localhost:3000')
  })

  it('defaults the base URL to AVSB_API_URL when it is set', async () => {
    process.env.AVSB_API_URL = 'http://localhost:4000'

    await runLogin(['--token', 'pat_new', '--no-input'])

    expect(savedConfig().apiBaseUrl).toBe('http://localhost:4000')
  })
})
