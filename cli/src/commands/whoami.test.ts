import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiAuthVerifyResponse } from '../types/account.js'
import type { AvsbSession } from '../types/config.js'

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
    verifyAuth: vi.fn(),
    ensureLoggedIn: vi.fn(),
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
vi.mock('../lib/logger.js', () => mocks.logger)
vi.mock('../lib/config.js', () => ({
  ensureLoggedIn: mocks.ensureLoggedIn,
  getConfigPath: () => CONFIG_PATH,
}))
vi.mock('../lib/api.js', () => ({
  ApiClient: class {
    verifyAuth = mocks.verifyAuth
  },
}))

import { buildWhoamiRows, roleName, whoamiCommand } from './whoami.js'

class ProcessExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

const verified: ApiAuthVerifyResponse['data'] = {
  email: 'dev@example.com',
  orgId: 'org-1',
  orgName: 'Acme Corp',
  role: 'DEVELOPER',
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

describe('buildWhoamiRows', () => {
  it('reports the account, organization, role, and where the token came from', () => {
    expect(buildWhoamiRows(verified, session(), CONFIG_PATH)).toEqual([
      { label: 'Email', value: 'dev@example.com' },
      { label: 'Organization', value: 'Acme Corp' },
      { label: 'Org ID', value: 'org-1' },
      { label: 'Role', value: 'DEVELOPER' },
      { label: 'API URL', value: 'https://app.avsb.cloud' },
      { label: 'Token from', value: CONFIG_PATH },
    ])
  })

  it('names the environment variable when the token came from there', () => {
    const rows = buildWhoamiRows(verified, session({ tokenSource: 'env' }), CONFIG_PATH)

    expect(rows.at(-1)).toEqual({
      label: 'Token from',
      value: 'AVSB_TOKEN environment variable',
    })
  })

  it('reports the base URL actually in use, not the default', () => {
    const rows = buildWhoamiRows(
      verified,
      session({ apiBaseUrl: 'http://localhost:3000' }),
      CONFIG_PATH,
    )

    expect(rows).toContainEqual({ label: 'API URL', value: 'http://localhost:3000' })
  })
})

describe('avsb whoami', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.spinner.start.mockReturnValue(mocks.spinner)
    mocks.ensureLoggedIn.mockReturnValue(session())
    mocks.verifyAuth.mockResolvedValue({ data: verified })
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ProcessExitError(typeof code === 'number' ? code : 0)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('asks about the active organization so the role shown is the role there', async () => {
    await whoamiCommand.parseAsync([], { from: 'user' })

    expect(mocks.verifyAuth).toHaveBeenCalledWith('org-1')
    // A result line, so `--quiet` keeps it (QA N4-14).
    expect(mocks.logger.field).toHaveBeenCalledWith('Email', 'dev@example.com')
  })

  it('asks about no particular organization when only AVSB_TOKEN is set', async () => {
    mocks.ensureLoggedIn.mockReturnValue(
      session({ orgId: '', orgName: '', tokenSource: 'env' }),
    )

    await whoamiCommand.parseAsync([], { from: 'user' })

    expect(mocks.verifyAuth).toHaveBeenCalledWith(undefined)
  })

  it('fails with the platform message when the token cannot be verified', async () => {
    mocks.verifyAuth.mockRejectedValue(new Error('Invalid token'))

    await expect(whoamiCommand.parseAsync([], { from: 'user' })).rejects.toThrow(
      ProcessExitError,
    )

    expect(mocks.logger.error).toHaveBeenCalledWith('Invalid token')
    expect(mocks.logger.label).not.toHaveBeenCalled()
  })
})

// QA N4-13: the platform sent the whole role record, printed as
// `Role: [object Object]`.
describe('roleName', () => {
  it('prints a role name as it is', () => {
    expect(roleName('OWNER')).toBe('OWNER')
  })

  it('reads the name off the role record an older platform sends', () => {
    const rows = buildWhoamiRows(
      { ...verified, role: { name: 'OWNER', manageProjects: true } as unknown as string },
      session(),
      CONFIG_PATH,
    )

    expect(rows.find((row) => row.label === 'Role')?.value).toBe('OWNER')
    expect(JSON.stringify(rows)).not.toContain('[object Object]')
  })

  it('says unknown rather than inventing a role', () => {
    expect(roleName(null)).toBe('unknown')
    expect(roleName({ id: 'role-1' })).toBe('unknown')
  })
})
