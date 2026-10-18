import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { AvsbSession } from '../types/config.js'

// The emitters have their own suites (lib/codegenEmit.test.ts and friends).
// What is only reachable through the command is the argument contract: which
// combinations of flags are refused, and with which exit code. Session 25 made
// those codes a documented promise, so they need a test that fails when they
// change.

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
    ensureLoggedIn: vi.fn(),
    getDatafileConditional: vi.fn(),
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
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  getConfigPath: () => '/home/tester/.avsb/config.json',
}))
vi.mock('../lib/codegenApi.js', () => ({
  CodegenApiClient: class {
    getDatafileConditional = mocks.getDatafileConditional
  },
}))

class ProcessExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

function session(): AvsbSession {
  return {
    token: 'avsb_pat_acme',
    orgId: 'org-1',
    orgName: 'Acme Corp',
    apiBaseUrl: 'https://app.avsb.cloud',
    tokenSource: 'config',
  }
}

/** Fresh command per run: commander keeps option values on the instance. */
async function runCodegen(argv: string[]): Promise<void> {
  vi.resetModules()
  const { codegenCommand } = await import('./codegen.js')
  await codegenCommand.parseAsync(argv, { from: 'user' })
}

/** Run and report the exit code, so a test never has to catch by hand. */
async function exitCodeOf(argv: string[]): Promise<number> {
  try {
    await runCodegen(argv)
  } catch (err) {
    if (err instanceof ProcessExitError) return err.code
    throw err
  }
  return 0
}

function errors(): string {
  return mocks.logger.error.mock.calls.map((call) => String(call[0] ?? '')).join('\n')
}

/** A path nothing has written, so `--check` reliably reports a missing file. */
function unwrittenOutput(): string {
  return path.join(os.tmpdir(), `avsb-codegen-test-${process.pid}`, 'flags.ts')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.spinner.start.mockReturnValue(mocks.spinner)
  mocks.ensureLoggedIn.mockReturnValue(session())
  mocks.getDatafileConditional.mockResolvedValue({
    status: 'ok',
    etag: null,
    body: {
      publishedAt: '2026-07-30T09:14:02.000Z',
      flags: [{ key: 'checkout_v2', type: 'boolean', variations: [{ value: true }] }],
    },
  })
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ProcessExitError(typeof code === 'number' ? code : 0)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.AVSB_JSON
})

describe('codegen — refused flag combinations', () => {
  it('refuses --check together with --watch, with the usage exit code', async () => {
    const code = await exitCodeOf(['--project', '42', '--check', '--watch'])

    expect(code).toBe(2)
    expect(errors()).toContain('Pass --check or --watch, not both.')
  })

  it('refuses --watch in JSON mode, because one document cannot be printed twice', async () => {
    const code = await exitCodeOf(['--project', '42', '--watch', '--json'])

    expect(code).toBe(2)
    expect(errors()).toContain('--watch cannot be combined with --json.')
  })

  it('refuses --watch when JSON mode came from the environment, not the flag', async () => {
    process.env.AVSB_JSON = '1'

    const code = await exitCodeOf(['--project', '42', '--watch'])

    expect(code).toBe(2)
    expect(errors()).toContain('--watch cannot be combined with --json.')
  })

  it('refuses --interval without --watch instead of silently ignoring it', async () => {
    const code = await exitCodeOf(['--project', '42', '--interval', '30'])

    expect(code).toBe(2)
    expect(errors()).toContain('--interval only means something with --watch.')
  })

  it('refuses an interval below the floor, and says why', async () => {
    const code = await exitCodeOf(['--project', '42', '--watch', '--interval', '1'])

    expect(code).toBe(2)
    expect(errors()).toContain('cached for 60 seconds')
  })

  it('refuses an interval that is not a number', async () => {
    expect(await exitCodeOf(['--project', '42', '--watch', '--interval', 'soon'])).toBe(2)
  })

  it('never reaches the platform when the arguments are wrong', async () => {
    await exitCodeOf(['--project', '42', '--check', '--watch'])

    expect(mocks.getDatafileConditional).not.toHaveBeenCalled()
    expect(mocks.ensureLoggedIn).not.toHaveBeenCalled()
  })
})

describe('codegen — accepted flag combinations', () => {
  it('accepts --check on its own and reports drift as failure, not usage', async () => {
    const code = await exitCodeOf(['--project', '42', '--check', '--output', unwrittenOutput()])

    // 1, not 2: the command ran and the answer was "out of date".
    expect(code).toBe(1)
    expect(errors()).toContain('out of date')
    expect(mocks.getDatafileConditional).toHaveBeenCalledTimes(1)
  })

  it('sends no If-None-Match on the first read, so 304 is not a legal answer', async () => {
    await exitCodeOf(['--project', '42', '--check', '--output', unwrittenOutput()])

    expect(mocks.getDatafileConditional).toHaveBeenCalledWith(42, 'production', null)
  })

  it('reads the environment it was given', async () => {
    await exitCodeOf([
      '--project', '42',
      '--env', 'staging',
      '--check',
      '--output', unwrittenOutput(),
    ])

    expect(mocks.getDatafileConditional).toHaveBeenCalledWith(42, 'staging', null)
  })
})

describe('codegen --check against a file it wrote (QA N4-5)', () => {
  let dir = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avsb-codegen-check-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function datafileAnswer(publishedAt: string | null, key = 'checkout_v2') {
    return {
      status: 'ok' as const,
      etag: null,
      body: { publishedAt, flags: [{ key, type: 'boolean', variations: [{ value: true }] }] },
    }
  }

  it('exits 0 on identical output, run after run', async () => {
    const output = path.join(dir, 'flags.ts')
    mocks.getDatafileConditional.mockResolvedValue(datafileAnswer('2026-09-30T08:15:00.000Z'))
    expect(await exitCodeOf(['--project', '42', '--output', output])).toBe(0)

    expect(await exitCodeOf(['--project', '42', '--check', '--output', output])).toBe(0)
    expect(await exitCodeOf(['--project', '42', '--check', '--output', output])).toBe(0)
    expect(errors()).toBe('')
  })

  it('exits 0 when the environment was published again with the same flags', async () => {
    const output = path.join(dir, 'flags.ts')
    mocks.getDatafileConditional.mockResolvedValue(datafileAnswer('2026-09-30T08:15:00.000Z'))
    await exitCodeOf(['--project', '42', '--output', output])

    mocks.getDatafileConditional.mockResolvedValue(datafileAnswer('2026-10-02T09:00:00.000Z'))

    expect(await exitCodeOf(['--project', '42', '--check', '--output', output])).toBe(0)
  })

  it('exits 1 and names the file when a flag changed on the platform', async () => {
    const output = path.join(dir, 'flags.ts')
    mocks.getDatafileConditional.mockResolvedValue(datafileAnswer('2026-09-30T08:15:00.000Z'))
    await exitCodeOf(['--project', '42', '--output', output])

    mocks.getDatafileConditional.mockResolvedValue(datafileAnswer('2026-10-02T09:00:00.000Z', 'checkout_v3'))

    expect(await exitCodeOf(['--project', '42', '--check', '--output', output])).toBe(1)
    expect(errors()).toContain('1 generated file is out of date.')
  })

  it('leaves an up-to-date file untouched on a second write', async () => {
    const output = path.join(dir, 'flags.ts')
    mocks.getDatafileConditional.mockResolvedValue(datafileAnswer(null))
    await exitCodeOf(['--project', '42', '--output', output])
    const before = fs.statSync(output).mtimeMs
    const contents = fs.readFileSync(output, 'utf-8')

    await exitCodeOf(['--project', '42', '--output', output])

    expect(fs.readFileSync(output, 'utf-8')).toBe(contents)
    expect(fs.statSync(output).mtimeMs).toBe(before)
    expect(contents).toContain('publishedAt=unknown')
  })
})
