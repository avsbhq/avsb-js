// =====================================================================
// N0-15 (production QA 2026-10-01): a malformed datafile must never reach
// the evaluator, whichever door it came through. The edge client refuses
// one from the `datafile` option, a fetched body, and a cached copy, and
// names the broken field each time.
// =====================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlagDatafile } from '@avsbhq/core'
import { AvsbEdgeClient } from './AvsbEdgeClient'
import { resetLogOnce } from './logger'
import { VALID_SDK_KEY, captureLogger, jsonResponse, makeStorage, testDatafile } from './fixtures'

const MALFORMED = { flags: {}, audiences: [] } as unknown as FlagDatafile

beforeEach(() => {
  resetLogOnce()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(testDatafile)))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the datafile option', () => {
  it('refuses a malformed one: reads answer not_ready instead of throwing', () => {
    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, datafile: MALFORMED, logLevel: 'silent' })

    expect(client.isReady()).toBe(false)
    expect(() => client.getBoolFlag('anything', true, { kind: 'user', key: 'u1' })).not.toThrow()
    expect(client.getBoolFlag('anything', true, { kind: 'user', key: 'u1' }).source).toBe(
      'not_ready'
    )
  })

  it('logs the broken field once and loads from the CDN at init()', async () => {
    const logger = captureLogger()
    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, datafile: MALFORMED, logger })

    expect(logger.messages('error')).toHaveLength(1)
    expect(logger.said('datafile.flags is an object, expected an array')).toBe(true)
    expect(await client.init()).toEqual({ success: true, source: 'network' })
    expect(client.isReady()).toBe(true)
  })
})

describe('a fetched body that is JSON but not a datafile', () => {
  it('fails init and names the URL and the broken field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ flags: 'nope' })))
    const logger = captureLogger()
    const client = new AvsbEdgeClient({ sdkKey: VALID_SDK_KEY, logger })

    const result = await client.init()

    expect(result.success).toBe(false)
    expect(client.isReady()).toBe(false)
    expect(logger.said('datafile.flags is a string, expected an array')).toBe(true)
    expect(logger.said(`/${VALID_SDK_KEY}/datafile.json`)).toBe(true)
  })
})

describe('a cached copy that is not a datafile', () => {
  it('is discarded, reported as a cache error, and replaced from the network', async () => {
    const onError = vi.fn()
    const client = new AvsbEdgeClient({
      sdkKey: VALID_SDK_KEY,
      storage: makeStorage({
        datafileGet: vi.fn().mockResolvedValue({ datafile: MALFORMED, cachedAt: Date.now() }),
      }),
      logLevel: 'silent',
      onError,
    })

    expect(await client.init()).toEqual({ success: true, source: 'network' })
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('discarded the cached datafile'),
      }),
      'cache'
    )
  })
})
