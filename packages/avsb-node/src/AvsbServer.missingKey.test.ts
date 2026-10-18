// N1-9 / N1-15 (production QA 2026-10-01): node served the default for a
// key the datafile does not carry with no word at all, so a key copied from
// an old hyphenated docs example (`new-checkout-flow`) failed silently. A
// miss is now reported once per key, with the platform spelling suggested.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FlagDatafile, Logger } from '@avsbhq/core'
import { AvsbServer } from './AvsbServer'

const SDK_KEY = 'sdk_production_missingkeynode01'
const USER = { kind: 'user', key: 'u1' }

function datafile(): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: SDK_KEY,
    environmentKey: 'production',
    publishedAt: '2026-10-01T00:00:00.000Z',
    collectEndpoint: 'https://collect.test.invalid',
    flags: [
      {
        id: 'flag_1',
        key: 'new_checkout_flow',
        type: 'boolean',
        enabled: true,
        defaultVariationId: 'var_on',
        variations: [{ id: 'var_on', key: 'on', value: true }],
        overrides: [],
        rules: [],
      },
    ],
    audiences: [],
  }
}

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = []
  return {
    warnings,
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message: string) => {
      warnings.push(message)
    },
    error: vi.fn(),
    child() {
      return this
    },
  }
}

const servers: AvsbServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

function makeServer(logger: Logger): AvsbServer {
  const server = new AvsbServer({ sdkKey: SDK_KEY, bootstrap: datafile(), streaming: false, logger })
  servers.push(server)
  return server
}

describe('AvsbServer reading a key the datafile does not carry', () => {
  it('warns once per key and suggests the platform spelling for a hyphenated key', () => {
    const logger = recordingLogger()
    const user = makeServer(logger).forUser(USER)

    for (let i = 0; i < 5; i++) expect(user.getBoolFlag('new-checkout-flow', false).source).toBe('not_found')

    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain('did you mean "new_checkout_flow"?')
  })

  it('points a valid but unknown key at the Flags page', () => {
    const logger = recordingLogger()
    makeServer(logger).getFlag('checkout_v3', 'off', USER)

    expect(logger.warnings[0]).toContain('"checkout_v3" is not in this environment\'s datafile')
    expect(logger.warnings[0]).toContain('Flags page')
  })

  it('says nothing for a key the datafile carries', () => {
    const logger = recordingLogger()
    expect(makeServer(logger).forUser(USER).getBoolFlag('new_checkout_flow', false).value).toBe(true)
    expect(logger.warnings).toEqual([])
  })
})
