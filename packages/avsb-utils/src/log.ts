// Logger surface for `@avsbhq/utils`. The shared multi-transport `Logger`
// (spec §2.13) lives in `@avsbhq/core`; this module re-exports it under
// the utils package namespace so consumers don't have to import from two
// packages. Adapter factories live in `./log/<adapter>.ts` and are exposed
// via subpath exports for tree-shaking.

import {
  createLogger as coreCreateLogger,
  consoleLogger as coreConsoleLogger,
  consoleTransport as coreConsoleTransport,
  noopLogger as coreNoopLogger,
} from '@avsbhq/core'
import type {
  Logger,
  LoggerOptions,
  LogTransport,
  LogLevel,
} from '@avsbhq/core'

export type { Logger, LoggerOptions, LogTransport, LogLevel }

export function createLogger(opts: LoggerOptions): Logger {
  return coreCreateLogger(opts)
}

export function consoleLogger(level?: LogLevel): Logger {
  return coreConsoleLogger(level)
}

export function createConsoleTransport(opts?: {
  level?: LogLevel
}): LogTransport {
  return coreConsoleTransport(opts?.level ?? 'info')
}

export const noopLogger: Logger = coreNoopLogger
