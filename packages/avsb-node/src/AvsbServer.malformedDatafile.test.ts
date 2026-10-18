// N0-15 (production QA 2026-10-01): `bootstrap: { flags: {} }` made
// `forUser(...).getBoolFlag(...)` throw `TypeError: datafile.flags.find is
// not a function` from inside the evaluator, although reads are documented
// never to throw. A malformed datafile is now refused where it enters the
// SDK, with an error naming the broken field, and reads answer `not_ready`.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlagDatafile, Logger } from '@avsbhq/core'
import { AvsbServer } from './AvsbServer'
import { acceptDatafile, fetchDatafile } from './datafileSource'

const SDK_KEY = 'sdk_production_malformedtest01'

function goodDatafile(publishedAt = '2026-10-01T00:00:00.000Z'): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
    publishedAt,
    collectEndpoint: 'https://collect.test.invalid',
    flags: [
      {
        id: 'flag_1',
        key: 'checkout_v2',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'var_off',
        variations: [
          { id: 'var_off', key: 'off', value: false },
          { id: 'var_on', key: 'on', value: true },
        ],
        overrides: [],
        rules: [
          {
            id: 'rule_1',
            type: 'targeted_delivery',
            enabled: true,
            audienceIds: [],
            hashAttribute: 'user.key',
            trafficAllocation: null,
            variations: [{ variationId: 'var_on', percentage: 1 }],
          },
        ],
      },
    ],
    audiences: [],
  }
}

/** The exact bootstrap the QA passed, typed the way a JS caller would hand it over. */
const MALFORMED = { flags: {}, audiences: [] } as unknown as FlagDatafile

function recordingLogger(): Logger & { errors: string[] } {
  const errors: string[] = []
  return {
    errors,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (message: string) => {
      errors.push(message)
    },
    child() {
      return this
    },
  }
}

const servers: AvsbServer[] = []
function makeServer(bootstrap: FlagDatafile, logger: Logger): AvsbServer {
  const server = new AvsbServer({ sdkKey: SDK_KEY, bootstrap, streaming: false, logger })
  servers.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  vi.restoreAllMocks()
})

describe('a malformed bootstrap datafile (N0-15)', () => {
  it('is refused, so reads answer not_ready instead of throwing', () => {
    const logger = recordingLogger()
    const server = makeServer(MALFORMED, logger)

    const read = () => server.forUser({ kind: 'user', key: 'u1' }).getBoolFlag('checkout_v2', true)
    expect(read).not.toThrow()
    expect(read().source).toBe('not_ready')
    expect(read().value).toBe(true)
    expect(server.isReady()).toBe(false)
  })

  it('logs one error that names the broken field', () => {
    const logger = recordingLogger()
    makeServer(MALFORMED, logger)

    expect(logger.errors).toHaveLength(1)
    expect(logger.errors[0]).toContain('datafile.flags is an object, expected an array')
    expect(logger.errors[0]).toContain('new AvsbServer()')
  })

  it('still adopts a well-formed bootstrap on the same tick', () => {
    const logger = recordingLogger()
    const server = makeServer(goodDatafile(), logger)

    expect(server.isReady()).toBe(true)
    expect(server.forUser({ kind: 'user', key: 'u1' }).getBoolFlag('checkout_v2', false).value).toBe(
      true
    )
    expect(logger.errors).toEqual([])
  })
})

describe('applyDatafileBootstrap with a malformed datafile', () => {
  it('keeps serving the datafile it already had', () => {
    const logger = recordingLogger()
    const server = makeServer(goodDatafile(), logger)

    server.applyDatafileBootstrap(MALFORMED)

    expect(server.getDatafile()?.publishedAt).toBe('2026-10-01T00:00:00.000Z')
    expect(server.forUser({ kind: 'user', key: 'u1' }).getBoolFlag('checkout_v2', false).value).toBe(
      true
    )
    expect(logger.errors[0]).toContain('applyDatafileBootstrap()')
  })
})

describe('acceptDatafile', () => {
  it('passes a readable datafile through untouched and logs nothing', () => {
    const logger = recordingLogger()
    const datafile = goodDatafile()
    expect(acceptDatafile(datafile, 'bootstrap', logger)).toBe(datafile)
    expect(logger.errors).toEqual([])
  })

  it('returns null for a value that is not an object at all', () => {
    const logger = recordingLogger()
    expect(acceptDatafile('not json', 'bootstrap', logger)).toBeNull()
    expect(logger.errors[0]).toContain('the datafile is a string, expected an object')
  })
})

describe('fetchDatafile with a malformed body', () => {
  it('reports failed, names the URL and the broken field, and adopts nothing', async () => {
    global.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ flags: 'nope' }), { status: 200 }))
    const logger = recordingLogger()

    const outcome = await fetchDatafile({
      sdkKey: SDK_KEY,
      cdnHost: 'https://cdn.test.invalid',
      signal: new AbortController().signal,
      logger,
    })

    expect(outcome).toEqual({ status: 'failed' })
    expect(logger.errors[0]).toContain(`https://cdn.test.invalid/${SDK_KEY}/datafile.json`)
    expect(logger.errors[0]).toContain('datafile.flags is a string, expected an array')
  })
})
