// Winston transport adapter. Routes the shared `Logger` API through a
// caller-supplied winston instance. Winston is a peerDep.

import type { LogLevel, LogTransport } from '@avsbhq/core'

export interface WinstonLike {
  log(level: string, message: string, meta?: Record<string, unknown>): void
}

export interface WinstonTransportOptions {
  logger: WinstonLike
  level?: LogLevel
}

export function createWinstonTransport(
  opts: WinstonTransportOptions
): LogTransport {
  return {
    level: opts.level ?? 'info',
    log(level, message, data) {
      opts.logger.log(level, message, data)
    },
  }
}
