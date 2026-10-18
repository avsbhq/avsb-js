import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { ApiClient } from './api.js'
import { toApiRequestError } from './apiError.js'
import { CliError } from './cliError.js'
import {
  classifyNetworkError,
  describeNetworkFailure,
  invalidBaseUrl,
  networkErrorCode,
} from './networkError.js'

/** What Node's fetch actually rejects with: the reason is only in `cause`. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause })
}

function withCode(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code })
}

describe('networkErrorCode', () => {
  it('finds the code under fetch\'s "fetch failed", including inside an AggregateError', () => {
    expect(networkErrorCode(fetchFailed(withCode('ENOTFOUND')))).toBe('ENOTFOUND')
    expect(networkErrorCode(fetchFailed(new AggregateError([withCode('ECONNREFUSED')], 'all failed')))).toBe(
      'ECONNREFUSED',
    )
    expect(networkErrorCode(new Error('plain'))).toBeNull()
  })
})

describe('describeNetworkFailure (QA N4-10)', () => {
  const base = 'https://app.avsb.invalid'

  it.each([
    ['ENOTFOUND', 'dns', 'Cannot find app.avsb.invalid: the name does not resolve (DNS lookup failed).'],
    ['ECONNREFUSED', 'refused', 'Nothing is listening at app.avsb.invalid: the connection was refused.'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout', 'app.avsb.invalid did not answer in time (the connection timed out).'],
    ['ECONNRESET', 'reset', 'app.avsb.invalid closed the connection before answering.'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls', 'Could not make a secure connection to app.avsb.invalid (UNABLE_TO_VERIFY_LEAF_SIGNATURE).'],
  ])('names the host and the kind for %s', (code, kind, message) => {
    expect(classifyNetworkError(code)).toBe(kind)
    const error = describeNetworkFailure(base, fetchFailed(withCode(code)))

    expect(error).toBeInstanceOf(CliError)
    expect(error.code).toBe('cli_network')
    expect(error.message).toBe(message)
    expect(error.message).not.toContain('fetch failed')
    expect(error.exitCode).toBe(1)
  })

  it('points a DNS failure at the API URL setting, not at the token', () => {
    const error = describeNetworkFailure(base, fetchFailed(withCode('ENOTFOUND')))

    expect(error.hints.join(' ')).toContain('AVSB_API_URL')
    expect(error.hints.join(' ')).not.toMatch(/token/i)
  })

  it('still names the host for an error it cannot classify', () => {
    expect(describeNetworkFailure(base, new Error('socket hang up')).message).toBe(
      'Could not reach app.avsb.invalid (socket hang up).',
    )
  })

  it('reads the reason undici hides under "fetch failed", such as a port fetch refuses to use', () => {
    expect(describeNetworkFailure('http://127.0.0.1:9', fetchFailed(new Error('bad port'))).message).toBe(
      'Could not reach 127.0.0.1:9 (bad port).',
    )
  })
})

describe('invalidBaseUrl', () => {
  it('refuses a value that is not an http(s) address, without echoing an internal path', () => {
    const error = invalidBaseUrl('notaurl')

    expect(error?.code).toBe('cli_usage')
    expect(error?.message).toBe('"notaurl" is not a valid API URL.')
    expect(error?.exitCode).toBe(2)
    expect(invalidBaseUrl('ftp://app.avsb.cloud')).not.toBeNull()
  })

  it('accepts http and https addresses', () => {
    expect(invalidBaseUrl('https://app.avsb.cloud')).toBeNull()
    expect(invalidBaseUrl('http://localhost:3000')).toBeNull()
  })
})

describe('a non-API answer names the host that gave it', () => {
  it('says which host answered with a page that is not the platform\'s', () => {
    expect(toApiRequestError({ status: 404, body: null, host: 'app.avsb.cloud' }).message).toBe(
      'app.avsb.cloud answered HTTP 404, which is not an A vs B API response. Check the API URL.',
    )
  })
})

describe('the transport, against a real closed port', () => {
  it('reports a refused connection with the host and port instead of "fetch failed"', async () => {
    const server = http.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    await new Promise((resolve) => server.close(resolve))

    const client = new ApiClient(
      { token: 'avsb_pat_aaaaaaaaaaaaaaaaaaaaaaaa', apiBaseUrl: `http://127.0.0.1:${port}` },
      { useEnvOverrides: false },
    )
    const error = await client.verifyAuth().catch((err: unknown) => err)

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toBe(`Nothing is listening at 127.0.0.1:${port}: the connection was refused.`)
  })

  it('refuses an API URL that is not a URL before making any request', async () => {
    const client = new ApiClient({ token: 'avsb_pat_aaaaaaaaaaaaaaaaaaaaaaaa', apiBaseUrl: 'notaurl' }, { useEnvOverrides: false })
    const error = await client.verifyAuth('org-secret-id').catch((err: unknown) => err)

    expect((error as CliError).message).toBe('"notaurl" is not a valid API URL.')
    expect((error as CliError).message).not.toContain('org-secret-id')
  })
})
