import type {
  Logger,
  LoggerOptions,
  LogLevel,
  LogTransport,
} from './types'

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

function shouldEmit(messageLevel: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_RANK[messageLevel] >= LEVEL_RANK[threshold]
}

/**
 * Build a `Logger` that fans out every emission to each configured
 * transport, after applying the global threshold and the transport's
 * own threshold. The shape mirrors LD's `LDLogger`, pino, and winston:
 * transports are arbitrary sinks (pino instance, winston instance,
 * console, Sentry hub, custom telemetry).
 */
export function createLogger(opts: LoggerOptions): Logger {
  const globalLevel: LogLevel = opts.level ?? 'info'
  const prefix = opts.prefix ?? ''
  const transports = opts.transports

  const emit = (
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>
  ): void => {
    if (!shouldEmit(level, globalLevel)) return
    const formatted = prefix ? `[${prefix}] ${message}` : message
    for (const t of transports) {
      if (!shouldEmit(level, t.level)) continue
      try {
        t.log(level, formatted, data)
      } catch {
        // Logger transports must never throw into the SDK hot path.
      }
    }
  }

  const child = (childPrefix: string): Logger =>
    createLogger({
      level: globalLevel,
      prefix: prefix ? `${prefix}:${childPrefix}` : childPrefix,
      transports,
    })

  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    child,
  }
}

/**
 * Logger that drops everything on the floor. The pre-launch SDKs use
 * this as the default, so there is no console noise during tests or in customers'
 * production traces unless they opt in.
 */
export const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
}

/**
 * Convenience console transport. Useful default for development.
 */
export function consoleTransport(level: LogLevel = 'info'): LogTransport {
  return {
    level,
    log(lvl, message, data) {
      const payload = data
        ? `${message} ${JSON.stringify(data)}`
        : message
      switch (lvl) {
        case 'debug':
        case 'info':
          // eslint-disable-next-line no-console -- transport sink, opt-in by consumer
          console.log(payload)
          break
        case 'warn':
          // eslint-disable-next-line no-console -- transport sink, opt-in by consumer
          console.warn(payload)
          break
        case 'error':
          // eslint-disable-next-line no-console -- transport sink, opt-in by consumer
          console.error(payload)
          break
      }
    },
  }
}

/**
 * Single-call console logger, handy for "I just want logs to appear"
 * in local development without composing transports.
 */
export function consoleLogger(level: LogLevel = 'info'): Logger {
  return createLogger({ level, transports: [consoleTransport(level)] })
}
