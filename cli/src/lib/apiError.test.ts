import { describe, expect, it } from 'vitest'
import { ApiRequestError, describeApiFailure, exitCodeForError, toApiRequestError } from './apiError.js'
import { EXIT } from './exitCodes.js'

describe('toApiRequestError — public API envelope', () => {
  it('keeps the code, message, doc link and request id', () => {
    const error = toApiRequestError({
      status: 403,
      body: {
        error: {
          code: 'scope_missing',
          message: 'Token is missing required scope: flags:write',
          docUrl: 'https://avsb.cloud/docs/developer-reference/public-api/conventions#refusals-at-403',
          requestId: 'req_123',
          details: { missingScope: 'flags:write' },
        },
      },
    })

    expect(error.status).toBe(403)
    expect(error.code).toBe('scope_missing')
    expect(error.message).toBe('Token is missing required scope: flags:write')
    expect(error.docUrl).toContain('#refusals-at-403')
    expect(error.requestId).toBe('req_123')
    expect(error.details).toEqual({ missingScope: 'flags:write' })
  })

  it('falls back to the response header for the request id', () => {
    const error = toApiRequestError({
      status: 500,
      body: { error: { code: 'internal_error', message: 'Something went wrong' } },
      requestId: 'req_from_header',
    })

    expect(error.requestId).toBe('req_from_header')
  })
})

describe('toApiRequestError — legacy CLI envelope', () => {
  it('reads a bare string message', () => {
    const error = toApiRequestError({ status: 404, body: { error: 'Event not found' } })

    expect(error.message).toBe('Event not found')
    expect(error.code).toBeUndefined()
    expect(error.docUrl).toBeUndefined()
  })

  it('passes the push upgrade answer through verbatim (CLI 3.9.0 refuses the pre-3.1.0 shape)', () => {
    const message = 'This CLI is older than 3.1.0; run npm install -g @avsbhq/cli@latest'
    const error = toApiRequestError({ status: 400, body: { error: message } })

    expect(error.message).toBe(message)
    expect(error.details).toBeUndefined()
    expect(describeApiFailure(error)).toEqual([])
  })

  it('keeps the sibling fields those routes send next to the message', () => {
    const error = toApiRequestError({
      status: 409,
      body: {
        error: 'Cannot delete: this event is still referenced by metrics',
        metricsReferencing: [{ id: 'mb1', name: 'Checkout rate' }],
      },
    })

    expect(error.details).toEqual({ metricsReferencing: [{ id: 'mb1', name: 'Checkout rate' }] })
  })

  it('still produces a usable error when the body is not JSON at all', () => {
    const error = toApiRequestError({ status: 502, body: null })

    expect(error.message).toBe('API error 502')
    expect(error.status).toBe(502)
  })

  it('reads Retry-After as whole seconds', () => {
    const error = toApiRequestError({
      status: 429,
      body: { error: { code: 'rate_limited', message: 'Rate limit exceeded' } },
      retryAfter: '30',
    })

    expect(error.retryAfterSeconds).toBe(30)
  })
})

describe('describeApiFailure', () => {
  it('names the credential the CLI needs on a 401', () => {
    const lines = describeApiFailure(
      new ApiRequestError({ status: 401, message: 'Unauthorized', code: 'unauthorized' }),
    )

    expect(lines.join(' ')).toContain('avsb_pat_')
    expect(lines.join(' ')).toContain('avsb whoami')
  })

  it('tells the caller to re-read and retry on a 412, and shows the current version', () => {
    const lines = describeApiFailure(
      new ApiRequestError({
        status: 412,
        message: 'The resource changed since you read it. Re-read it and retry.',
        code: 'precondition_failed',
        details: { expected: 'W/"abc123"' },
      }),
    )

    expect(lines.join(' ')).toContain('Re-read it')
    expect(lines.join(' ')).toContain('W/"abc123"')
  })

  it('prints the doc link and request id when the platform sent them', () => {
    const lines = describeApiFailure(
      new ApiRequestError({
        status: 400,
        message: 'Request body failed validation',
        code: 'validation_failed',
        docUrl: 'https://avsb.cloud/docs/x#validation-errors',
        requestId: 'req_9',
      }),
    )

    expect(lines).toContain('Docs: https://avsb.cloud/docs/x#validation-errors')
    expect(lines).toContain('Request id: req_9')
  })

  it('says how long to wait when rate limited', () => {
    const lines = describeApiFailure(
      new ApiRequestError({
        status: 429,
        message: 'Rate limit exceeded',
        code: 'rate_limited',
        retryAfterSeconds: 12,
      }),
    )

    expect(lines.join(' ')).toContain('Retry in 12s')
  })
})

describe('exit codes', () => {
  it('maps credential refusals to the auth code and stale writes to the conflict code', () => {
    expect(new ApiRequestError({ status: 401, message: 'x' }).exitCode).toBe(EXIT.auth)
    expect(new ApiRequestError({ status: 403, message: 'x' }).exitCode).toBe(EXIT.auth)
    expect(new ApiRequestError({ status: 412, message: 'x' }).exitCode).toBe(EXIT.conflict)
    expect(new ApiRequestError({ status: 409, message: 'x' }).exitCode).toBe(EXIT.conflict)
    expect(new ApiRequestError({ status: 500, message: 'x' }).exitCode).toBe(EXIT.failure)
  })

  it('treats anything that is not an API error as a plain failure', () => {
    expect(exitCodeForError(new Error('disk full'))).toBe(EXIT.failure)
    expect(exitCodeForError('nope')).toBe(EXIT.failure)
  })
})
