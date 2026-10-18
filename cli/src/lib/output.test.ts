import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from './apiError.js'
import { CliError } from './cliError.js'
import { EXIT } from './exitCodes.js'
import {
  beginCommand,
  emitJsonResult,
  exitCodeFor,
  failCommand,
  resetCommandName,
  toJsonErrorBody,
  UNCLASSIFIED_API_ERROR_CODE,
} from './output.js'
import { resetOutputMode } from './outputMode.js'

function stdout(): string[] {
  return vi.mocked(process.stdout.write).mock.calls.map((call) => String(call[0]))
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  resetOutputMode()
  resetCommandName()
  vi.restoreAllMocks()
})

describe('emitJsonResult', () => {
  it('prints nothing and reports not-handled in human mode', () => {
    beginCommand('flags list', {})

    expect(emitJsonResult({ flags: [] })).toBe(false)
    expect(stdout()).toEqual([])
  })

  it('prints one envelope naming the command, and reports handled', () => {
    beginCommand('flags list', { json: true })

    expect(emitJsonResult({ flags: [] })).toBe(true)
    expect(stdout()).toHaveLength(1)
    expect(JSON.parse(stdout()[0])).toEqual({
      ok: true,
      command: 'flags list',
      data: { flags: [] },
    })
  })

  it('puts response facts in meta so data stays exactly what the API returned', () => {
    beginCommand('flags get', { json: true })

    emitJsonResult({ key: 'checkout_v2' }, { etag: 'W/"abc"' })

    expect(JSON.parse(stdout()[0])).toEqual({
      ok: true,
      command: 'flags get',
      data: { key: 'checkout_v2' },
      meta: { etag: 'W/"abc"' },
    })
  })

  it('leaves meta out when there is nothing to say', () => {
    beginCommand('flags get', { json: true })

    emitJsonResult({ key: 'checkout_v2' }, {})

    expect(JSON.parse(stdout()[0])).not.toHaveProperty('meta')
  })
})

describe('toJsonErrorBody', () => {
  it('passes an API refusal through unchanged, so the CLI and the API speak one vocabulary', () => {
    const body = toJsonErrorBody(
      new ApiRequestError({
        status: 412,
        message: 'The resource changed since you read it. Re-read it and retry.',
        code: 'precondition_failed',
        docUrl: 'https://avsb.cloud/docs/x#etag--if-match',
        requestId: 'req_1',
        details: { expected: 'W/"abc"' },
      }),
    )

    expect(body).toEqual({
      code: 'precondition_failed',
      message: 'The resource changed since you read it. Re-read it and retry.',
      status: 412,
      docUrl: 'https://avsb.cloud/docs/x#etag--if-match',
      requestId: 'req_1',
      details: { expected: 'W/"abc"' },
    })
  })

  it('marks a refusal from a route that sends no machine code', () => {
    const body = toJsonErrorBody(new ApiRequestError({ status: 404, message: 'Event not found' }))

    expect(body.code).toBe(UNCLASSIFIED_API_ERROR_CODE)
    expect(body.status).toBe(404)
  })

  it('prefixes CLI-side failures so a script can tell them apart', () => {
    const body = toJsonErrorBody(
      new CliError('cli_no_project', 'No project specified.', ['Pass --project PRJ-42.']),
    )

    expect(body.code).toBe('cli_no_project')
    expect(body.details).toEqual({ hints: ['Pass --project PRJ-42.'] })
    expect(body).not.toHaveProperty('status')
  })

  it('falls back to a generic code for an unexpected throw', () => {
    expect(toJsonErrorBody(new Error('disk full'))).toEqual({
      code: 'cli_failed',
      message: 'disk full',
    })
  })
})

describe('exitCodeFor', () => {
  it('uses the credential code for a missing login and the usage code for bad input', () => {
    expect(exitCodeFor(new CliError('cli_not_logged_in', 'Not logged in.'))).toBe(EXIT.auth)
    expect(exitCodeFor(new CliError('cli_usage', 'Bad flag.'))).toBe(EXIT.usage)
    expect(exitCodeFor(new CliError('cli_conflict', 'Stale.'))).toBe(EXIT.conflict)
    expect(exitCodeFor(new Error('boom'))).toBe(EXIT.failure)
  })
})

describe('failCommand', () => {
  it('exits with the credential code and says why, on stderr', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${String(code)}`)
    })
    beginCommand('whoami', {})

    expect(() => failCommand(new CliError('cli_not_logged_in', 'Not logged in.', ['Run `avsb login`.'])))
      .toThrow('exit:3')

    expect(exit).toHaveBeenCalledWith(EXIT.auth)
    const stderr = vi.mocked(process.stderr.write).mock.calls.map((call) => String(call[0])).join('')
    expect(stderr).toContain('Not logged in.')
    expect(stderr).toContain('Run `avsb login`.')
    expect(stdout()).toEqual([])
  })

  it('also prints the error envelope on stdout in JSON mode, so one parser covers both outcomes', () => {
    vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit')
    })
    beginCommand('flags toggle', { json: true })

    expect(() =>
      failCommand(
        new ApiRequestError({ status: 404, message: 'Flag not found', code: 'not_found' }),
      ),
    ).toThrow('exit')

    expect(JSON.parse(stdout()[0])).toEqual({
      ok: false,
      command: 'flags toggle',
      error: { code: 'not_found', message: 'Flag not found', status: 404 },
    })
  })
})
