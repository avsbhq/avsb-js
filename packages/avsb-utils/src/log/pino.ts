// Pino transport adapter. Routes the shared `Logger` API through a caller-
// supplied pino instance.
//
// Pino is intentionally a peerDep — consumers who want pino bring their own.

import type { LogLevel, LogTransport } from '@avsbhq/core'

export interface PinoLike {
  debug(obj: unknown, msg?: string): void
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface PinoTransportOptions {
  logger: PinoLike
  /** Per-transport threshold. Defaults to 'info'. */
  level?: LogLevel
}

export function createPinoTransport(
  opts: PinoTransportOptions
): LogTransport {
  return {
    level: opts.level ?? 'info',
    log(level, message, data) {
      const payload = data ?? {}
      switch (level) {
        case 'debug':
          opts.logger.debug(payload, message)
          break
        case 'info':
          opts.logger.info(payload, message)
          break
        case 'warn':
          opts.logger.warn(payload, message)
          break
        case 'error':
          opts.logger.error(payload, message)
          break
      }
    },
  }
}
