// Default logger behaviour (spec §1.2, breaking change B2). The server SDK
// used to default to `noopLogger`, so a typo'd SDK key produced nothing at all
// on a server: no throw, no line, every flag quietly on its default.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { noopLogger } from '@avsbhq/core'
import { defaultLogger, isDevEnvironment, resolveServerLogger } from './logger'

const ORIGINAL_NODE_ENV = process.env.NODE_ENV

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.NODE_ENV
    return
  }
  process.env.NODE_ENV = value
}

afterEach(() => {
  setNodeEnv(ORIGINAL_NODE_ENV)
  delete (globalThis as { __AVSB_DEV__?: unknown }).__AVSB_DEV__
  vi.restoreAllMocks()
})

describe('isDevEnvironment', () => {
  it('is false in production', () => {
    setNodeEnv('production')
    expect(isDevEnvironment()).toBe(false)
  })

  it('is false under a test runner, so SDK diagnostics never pollute test output', () => {
    setNodeEnv('test')
    expect(isDevEnvironment()).toBe(false)
  })

  it('is true in development', () => {
    setNodeEnv('development')
    expect(isDevEnvironment()).toBe(true)
  })

  it('is true when NODE_ENV is not set at all, which is a bare `node server.js`', () => {
    setNodeEnv(undefined)
    expect(isDevEnvironment()).toBe(true)
  })

  it('lets __AVSB_DEV__ override NODE_ENV in either direction', () => {
    setNodeEnv('production')
    ;(globalThis as { __AVSB_DEV__?: unknown }).__AVSB_DEV__ = true
    expect(isDevEnvironment()).toBe(true)

    setNodeEnv('development')
    ;(globalThis as { __AVSB_DEV__?: unknown }).__AVSB_DEV__ = false
    expect(isDevEnvironment()).toBe(false)
  })

  it('ignores a non-boolean __AVSB_DEV__ rather than treating it as truthy', () => {
    setNodeEnv('production')
    ;(globalThis as { __AVSB_DEV__?: unknown }).__AVSB_DEV__ = 'yes'
    expect(isDevEnvironment()).toBe(false)
  })
})

describe('defaultLogger', () => {
  it('writes warnings to the console in development', () => {
    setNodeEnv('development')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    defaultLogger().warn('datafile request failed')

    expect(warn).toHaveBeenCalledOnce()
    expect(String(warn.mock.calls[0][0])).toContain('datafile request failed')
  })

  it('drops debug lines in development, so warn is the threshold', () => {
    setNodeEnv('development')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    defaultLogger().debug('polling')

    expect(log).not.toHaveBeenCalled()
  })

  it('is the noop logger in production', () => {
    setNodeEnv('production')
    expect(defaultLogger()).toBe(noopLogger)
  })
})

describe('resolveServerLogger', () => {
  beforeEach(() => {
    setNodeEnv('development')
  })

  it('an explicit logger always wins', () => {
    const custom = { ...noopLogger }
    expect(resolveServerLogger({ logger: custom })).toBe(custom)
  })

  it("logLevel 'silent' restores the old no-output behaviour", () => {
    expect(resolveServerLogger({ logLevel: 'silent' })).toBe(noopLogger)
  })

  it('logLevel forces a level on, even in production', () => {
    setNodeEnv('production')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    resolveServerLogger({ logLevel: 'debug' }).debug('datafile updated')

    expect(log).toHaveBeenCalledOnce()
  })

  it('falls back to the dev/production default when neither option is passed', () => {
    setNodeEnv('production')
    expect(resolveServerLogger({})).toBe(noopLogger)
  })
})
