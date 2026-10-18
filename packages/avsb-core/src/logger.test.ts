import { describe, it, expect, vi } from 'vitest'
import { createLogger, noopLogger } from './logger'
import type { LogLevel, LogTransport } from './types'

function recordingTransport(level: LogLevel = 'debug'): {
  transport: LogTransport
  calls: Array<{
    level: LogLevel
    message: string
    data?: Record<string, unknown>
  }>
} {
  const calls: Array<{
    level: LogLevel
    message: string
    data?: Record<string, unknown>
  }> = []
  return {
    calls,
    transport: {
      level,
      log: (lvl, message, data) => {
        calls.push({ level: lvl, message, data })
      },
    },
  }
}

describe('createLogger', () => {
  it('fans out to every transport at-or-above the global threshold', () => {
    const a = recordingTransport('debug')
    const b = recordingTransport('debug')
    const log = createLogger({
      level: 'info',
      transports: [a.transport, b.transport],
    })
    log.debug('hidden') // below threshold
    log.info('shown')
    expect(a.calls).toHaveLength(1)
    expect(a.calls[0].message).toBe('shown')
    expect(b.calls).toHaveLength(1)
  })

  it('respects per-transport level filtering', () => {
    const verbose = recordingTransport('debug')
    const quiet = recordingTransport('error')
    const log = createLogger({
      level: 'debug',
      transports: [verbose.transport, quiet.transport],
    })
    log.warn('warning')
    expect(verbose.calls).toHaveLength(1)
    expect(quiet.calls).toHaveLength(0)
  })

  it('prefixes formatted messages', () => {
    const t = recordingTransport('debug')
    const log = createLogger({
      level: 'debug',
      prefix: 'avsb',
      transports: [t.transport],
    })
    log.info('hello')
    expect(t.calls[0].message).toBe('[avsb] hello')
  })

  it('child() composes prefixes and shares transports', () => {
    const t = recordingTransport('debug')
    const log = createLogger({
      prefix: 'avsb',
      transports: [t.transport],
    })
    const child = log.child('tracker')
    child.info('queued')
    expect(t.calls[0].message).toBe('[avsb:tracker] queued')
  })

  it('does not propagate transport exceptions into the SDK', () => {
    const throwing: LogTransport = {
      level: 'debug',
      log: () => {
        throw new Error('transport blew up')
      },
    }
    const log = createLogger({ transports: [throwing] })
    expect(() => log.error('safe')).not.toThrow()
  })
})

describe('noopLogger', () => {
  it('discards every call', () => {
    expect(() => {
      noopLogger.debug('a')
      noopLogger.info('b')
      noopLogger.warn('c')
      noopLogger.error('d')
    }).not.toThrow()
  })

  it('child() returns a noop logger', () => {
    const c = noopLogger.child('x')
    expect(() => c.info('y')).not.toThrow()
  })
})

describe('LogLevel threshold semantics', () => {
  it('error transports drop info/debug/warn', () => {
    const t = recordingTransport('error')
    const log = createLogger({ level: 'debug', transports: [t.transport] })
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0].level).toBe('error')
  })

  it('passes structured data through to the transport', () => {
    const t = recordingTransport('debug')
    const log = createLogger({ transports: [t.transport] })
    const spy = vi.fn()
    void spy
    log.warn('detail', { flagKey: 'x', userId: 'u_1' })
    expect(t.calls[0].data).toEqual({ flagKey: 'x', userId: 'u_1' })
  })
})
