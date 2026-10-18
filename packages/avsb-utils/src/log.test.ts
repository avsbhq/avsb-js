import { describe, expect, it, vi } from 'vitest'
import { createLogger, consoleLogger, createConsoleTransport, noopLogger } from './log'
import { createPinoTransport } from './log/pino'
import { createWinstonTransport } from './log/winston'

describe('createLogger (re-export)', () => {
  it('fans out to every transport above the threshold', () => {
    const log = vi.fn()
    const logger = createLogger({
      level: 'debug',
      transports: [{ level: 'debug', log }],
    })
    logger.debug('msg')
    logger.info('msg')
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('filters out messages below the level threshold', () => {
    const log = vi.fn()
    const logger = createLogger({
      level: 'warn',
      transports: [{ level: 'debug', log }],
    })
    logger.debug('skip')
    logger.warn('keep')
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('child loggers inherit transports and prefix', () => {
    const log = vi.fn()
    const root = createLogger({
      level: 'debug',
      prefix: 'root',
      transports: [{ level: 'debug', log }],
    })
    const child = root.child('child')
    child.info('hello')
    expect(log).toHaveBeenCalledWith('info', '[root:child] hello', undefined)
  })
})

describe('noopLogger', () => {
  it('all methods return undefined', () => {
    expect(noopLogger.info('x')).toBeUndefined()
    expect(noopLogger.error('x')).toBeUndefined()
  })
})

describe('consoleLogger + createConsoleTransport', () => {
  it('produces a usable logger from a transport', () => {
    const t = createConsoleTransport({ level: 'error' })
    expect(t.level).toBe('error')
    const logger = consoleLogger('debug')
    expect(typeof logger.info).toBe('function')
  })
})

describe('createPinoTransport', () => {
  it('routes each level through the matching pino method', () => {
    const pinoLike = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const t = createPinoTransport({ logger: pinoLike, level: 'debug' })
    t.log('info', 'hi', { a: 1 })
    expect(pinoLike.info).toHaveBeenCalledWith({ a: 1 }, 'hi')
    t.log('error', 'oops')
    expect(pinoLike.error).toHaveBeenCalledWith({}, 'oops')
  })

  it('defaults its threshold to info', () => {
    const t = createPinoTransport({
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })
    expect(t.level).toBe('info')
  })
})

describe('createWinstonTransport', () => {
  it('routes log(level, message, data) through the winston instance', () => {
    const w = { log: vi.fn() }
    const t = createWinstonTransport({ logger: w, level: 'warn' })
    t.log('warn', 'something', { code: 1 })
    expect(w.log).toHaveBeenCalledWith('warn', 'something', { code: 1 })
  })

  it('honours the level passed to the transport', () => {
    const w = { log: vi.fn() }
    const t = createWinstonTransport({ logger: w, level: 'error' })
    expect(t.level).toBe('error')
  })
})
