import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AvsbClient } from './AvsbClient'
import type { FlagDatafile } from '@avsbhq/core'

const datafile: FlagDatafile = {
  version: 2,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk',
  environmentKey: 'prod',
  publishedAt: '2026-05-28T00:00:00Z',
  collectEndpoint: 'https://collect.test',
  flags: [],
  audiences: [],
}

describe('AvsbClient.utils', () => {
  let client: AvsbClient

  beforeEach(() => {
    client = new AvsbClient({
      sdkKey: 'sdk',
      bootstrap: datafile,
      context: { kind: 'user', key: 'u_1' },
    })
  })

  afterEach(async () => {
    await client.close()
  })

  it('exposes the AvsbUtils surface lazily', () => {
    expect(typeof client.utils.once).toBe('function')
    expect(typeof client.utils.context.defineSchema).toBe('function')
    expect(typeof client.utils.snapshot).toBe('function')
  })

  it('returns the same instance on repeated access', () => {
    expect(client.utils).toBe(client.utils)
  })

  it('once() correctly wraps the supplied function', () => {
    const fn = vi.fn((n: number) => n * 2)
    const wrapped = client.utils.once(fn)
    expect(wrapped(3)).toBe(6)
    expect(wrapped(7)).toBe(6)
    expect(fn).toHaveBeenCalledOnce()
  })

  it('snapshot() returns the current flag set keyed by flagKey', () => {
    const snap = client.utils.snapshot()
    expect(typeof snap.capturedAt).toBe('number')
    expect(snap.flags).toEqual({})
    expect(snap.contextSummary).toEqual([{ kind: 'user', key: 'u_1' }])
  })

  it('teardowns registered via utils.registerCleanup drain on close()', async () => {
    const teardown = vi.fn()
    client.utils.registerCleanup(teardown)
    await client.close()
    expect(teardown).toHaveBeenCalledOnce()
  })
})
