import { afterEach, describe, expect, it, vi } from 'vitest'
import { noopLogger } from '@avsbhq/core'
import { defaultLogger, isDevEnvironment, resolveLogger } from './logger'

/**
 * Replace `process` with a double carrying the NODE_ENV under test. Passing
 * an env with no NODE_ENV exercises the browser case, where `process` either
 * does not exist or was never substituted by a bundler.
 */
function withNodeEnv(nodeEnv?: string): void {
  vi.stubGlobal('process', { env: nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { __AVSB_DEV__?: unknown }).__AVSB_DEV__
})

describe('isDevEnvironment', () => {
  it('honours an explicit __AVSB_DEV__ flag over every other signal', () => {
    withNodeEnv('production')
    ;(globalThis as { __AVSB_DEV__?: unknown }).__AVSB_DEV__ = true
    expect(isDevEnvironment()).toBe(true)

    ;(globalThis as { __AVSB_DEV__?: unknown }).__AVSB_DEV__ = false
    withNodeEnv('development')
    expect(isDevEnvironment()).toBe(false)
  })

  it('is quiet in production and in test runners', () => {
    withNodeEnv('production')
    expect(isDevEnvironment()).toBe(false)

    // A test runner is not a developer watching a console, and SDK
    // diagnostics must not pollute a customer's test output.
    withNodeEnv('test')
    expect(isDevEnvironment()).toBe(false)
  })

  it('is loud for any other NODE_ENV', () => {
    withNodeEnv('development')
    expect(isDevEnvironment()).toBe(true)

    withNodeEnv('staging')
    expect(isDevEnvironment()).toBe(true)
  })

  it('falls back to the local-host heuristic when NODE_ENV says nothing', () => {
    // This is the Vite dev server case: browser code has no NODE_ENV, and
    // without this the developer we most want to reach gets silence.
    withNodeEnv(undefined)
    expect(location.hostname).toBe('localhost')
    expect(isDevEnvironment()).toBe(true)
  })
})

describe('defaultLogger', () => {
  it('is the noop logger when the environment is not development', () => {
    withNodeEnv('production')
    expect(defaultLogger()).toBe(noopLogger)
  })

  it('emits warnings and errors, but not debug, in development', () => {
    withNodeEnv('development')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const logger = defaultLogger()
    logger.debug('not shown')
    logger.warn('shown')
    logger.error('shown too')

    expect(log).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)

    warn.mockRestore()
    error.mockRestore()
    log.mockRestore()
  })
})

describe('resolveLogger', () => {
  it('prefers an explicitly passed logger', () => {
    withNodeEnv('development')
    const custom = { ...noopLogger }
    expect(resolveLogger({ logger: custom })).toBe(custom)
  })

  it("treats logLevel 'silent' as a hard off switch", () => {
    withNodeEnv('development')
    expect(resolveLogger({ logLevel: 'silent' })).toBe(noopLogger)
  })

  it('forces logging on at the requested level even in production', () => {
    withNodeEnv('production')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    resolveLogger({ logLevel: 'debug' }).debug('hello')

    expect(log).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })
})
