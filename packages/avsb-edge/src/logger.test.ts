// =====================================================================
// logger.ts — default resolution, dev detection, isolate-scoped dedupe.
// =====================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { noopLogger } from '@avsbhq/core'
import { defaultLogger, isDevEnvironment, logOnce, resetLogOnce, resolveLogger } from './logger'
import { captureLogger } from './fixtures'

beforeEach(() => {
  resetLogOnce()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isDevEnvironment', () => {
  it('honours an explicit __AVSB_DEV__ global over everything else', () => {
    vi.stubGlobal('__AVSB_DEV__', true)
    vi.stubGlobal('process', { env: { NODE_ENV: 'production' } })

    expect(isDevEnvironment()).toBe(true)
  })

  it('treats production and test as not development', () => {
    vi.stubGlobal('__AVSB_DEV__', undefined)

    vi.stubGlobal('process', { env: { NODE_ENV: 'production' } })
    expect(isDevEnvironment()).toBe(false)

    // A test runner is not a developer watching a log stream, and SDK
    // diagnostics would pollute a customer's test output.
    vi.stubGlobal('process', { env: { NODE_ENV: 'test' } })
    expect(isDevEnvironment()).toBe(false)
  })

  it('treats any other NODE_ENV as development', () => {
    vi.stubGlobal('__AVSB_DEV__', undefined)
    vi.stubGlobal('process', { env: { NODE_ENV: 'development' } })

    expect(isDevEnvironment()).toBe(true)
  })

  it('assumes a deployed worker when there is no process and no dev global', () => {
    vi.stubGlobal('__AVSB_DEV__', undefined)
    vi.stubGlobal('process', undefined)

    // Workers and Deno have no `process`. Warnings still reach the operator's
    // log stream; only debug detail is suppressed.
    expect(isDevEnvironment()).toBe(false)
  })
})

describe('resolveLogger', () => {
  it('returns an explicit logger untouched', () => {
    const logger = captureLogger()
    expect(resolveLogger({ logger })).toBe(logger)
  })

  it('returns the noop logger for logLevel silent', () => {
    expect(resolveLogger({ logLevel: 'silent' })).toBe(noopLogger)
  })

  it('is never the noop logger by default, unlike the browser SDK', () => {
    // Edge logs go to the operator's own log stream, and a wrong SDK key
    // serving defaults to real traffic must not be silent.
    expect(resolveLogger({})).not.toBe(noopLogger)
    expect(defaultLogger()).not.toBe(noopLogger)
  })

  it('emits at the forced level when logLevel is set', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const debugSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const logger = resolveLogger({ logLevel: 'warn' })
    logger.debug('quiet')
    logger.warn('loud')

    expect(debugSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })
})

describe('logOnce', () => {
  it('emits the first time a key is seen and returns true', () => {
    const logger = captureLogger()

    expect(logOnce(logger, 'warn', 'k', 'first')).toBe(true)
    expect(logger.messages('warn')).toEqual(['first'])
  })

  it('suppresses repeats of the same key and returns false', () => {
    const logger = captureLogger()

    logOnce(logger, 'warn', 'k', 'first')
    const second = logOnce(logger, 'warn', 'k', 'first')

    // Clients are per request, so per-instance state would fire every time.
    expect(second).toBe(false)
    expect(logger.lines).toHaveLength(1)
  })

  it('keeps distinct keys independent', () => {
    const logger = captureLogger()

    logOnce(logger, 'warn', 'a', 'message a')
    logOnce(logger, 'error', 'b', 'message b')

    expect(logger.messages()).toEqual(['message a', 'message b'])
  })

  it('re-arms every message once the remembered set is cleared', () => {
    const logger = captureLogger()

    logOnce(logger, 'warn', 'k', 'first')
    resetLogOnce()
    logOnce(logger, 'warn', 'k', 'first')

    expect(logger.lines).toHaveLength(2)
  })

  it('does not grow without bound as keys accumulate', () => {
    const logger = captureLogger()

    // 250 distinct keys against a 200-entry cap: the set clears rather than
    // silently dropping new messages, so nothing goes permanently unsaid.
    for (let i = 0; i < 250; i++) logOnce(logger, 'warn', `key-${i}`, `message ${i}`)

    expect(logger.lines).toHaveLength(250)
    // The earliest key was forgotten, so it can be said again.
    expect(logOnce(logger, 'warn', 'key-0', 'message 0')).toBe(true)
  })
})
