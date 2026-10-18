// =====================================================================
// N1-15 / N1-9 (production QA 2026-10-01): a read of a key the datafile
// does not carry is reported once per key, as a missing key (not as "not a
// boolean flag"), with the platform spelling suggested for a hyphenated
// key. A real type mismatch is still reported, once per key and getter.
// =====================================================================

import { beforeEach, describe, expect, it } from 'vitest'
import { AvsbEdgeClient } from './AvsbEdgeClient'
import { resetLogOnce } from './logger'
import { VALID_SDK_KEY, captureLogger, testDatafile } from './fixtures'

const CTX = { kind: 'user', key: 'u1' }

beforeEach(() => {
  resetLogOnce()
})

function makeClient(logger: ReturnType<typeof captureLogger>): AvsbEdgeClient {
  return new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, datafile: testDatafile, logger, heartbeat: false })
}

describe('a read of a key the datafile does not carry', () => {
  it('warns once across 100 typed reads, as a missing key', async () => {
    const logger = captureLogger()
    const client = makeClient(logger)
    await client.init()

    for (let i = 0; i < 100; i++) client.getBoolFlag('qa_sdk_missing', true, CTX)

    const warnings = logger.messages('warn')
    expect(client.getBoolFlag('qa_sdk_missing', true, CTX).source).toBe('not_found')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"qa_sdk_missing" is not in this environment\'s datafile')
    expect(warnings[0]).not.toMatch(/getter|is not a boolean flag/)
  })

  it('shares the warning between typed and untyped reads', async () => {
    const logger = captureLogger()
    const client = makeClient(logger)
    await client.init()

    client.getFlag('qa_sdk_missing', 'x', CTX)
    client.getStringFlag('qa_sdk_missing', 'x', CTX)

    expect(logger.messages('warn')).toHaveLength(1)
  })

  it('suggests the platform spelling for a hyphenated key', async () => {
    const logger = captureLogger()
    const client = makeClient(logger)
    await client.init()

    client.getBoolFlag('new-checkout-flow', false, CTX)

    expect(logger.said('did you mean "new_checkout_flow"?')).toBe(true)
  })
})
