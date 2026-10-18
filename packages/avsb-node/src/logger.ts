// =====================================================================
// Logging for the server SDK (spec §1.2, breaking change B2).
//
// The default used to be `noopLogger`, so a typo'd SDK key produced NOTHING
// on a server: no throw, no line, every flag quietly on its default. The
// default is now a console transport at WARN level in development and a noop
// in production, so the SDK is loud exactly where a developer is watching and
// silent in a customer's production logs.
//
// HOW "DEVELOPMENT" IS DECIDED, in order, first answer wins:
//
//   1. `logger` option            an explicit Logger always wins.
//   2. `logLevel` option          'silent' for a noop, or a level to force on.
//   3. `globalThis.__AVSB_DEV__`  boolean escape hatch for odd runtimes.
//   4. `process.env.NODE_ENV`     'production' is silent. 'test' is silent
//      too: a test runner is not a developer watching a console, and SDK
//      diagnostics would pollute a customer's test output.
//   5. No NODE_ENV at all is treated as development, which is what a bare
//      `node server.js` looks like.
//
// Note the difference from the browser package, which cannot rely on
// `process` existing and falls back to a localhost heuristic. On a server
// `process.env` is always there, so this file is deliberately the simpler of
// the two rather than a copy.
// =====================================================================

import { consoleLogger, noopLogger, createLogger, consoleTransport } from '@avsbhq/core'
import type { Logger, LogLevel } from '@avsbhq/core'

export { noopLogger, createLogger, consoleLogger, consoleTransport }

/** `logLevel` option values. 'silent' selects the noop logger. */
export type ServerLogLevel = LogLevel | 'silent'

function readDevGlobal(): boolean | null {
  const flag = (globalThis as { __AVSB_DEV__?: unknown }).__AVSB_DEV__
  return typeof flag === 'boolean' ? flag : null
}

function readNodeEnv(): string | null {
  const value = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env?.NODE_ENV
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * True when this process looks like a development environment. Exported so
 * the behaviour is directly testable and so a caller can mirror the decision.
 */
export function isDevEnvironment(): boolean {
  const explicit = readDevGlobal()
  if (explicit !== null) return explicit

  const nodeEnv = readNodeEnv()
  if (nodeEnv === null) return true
  return nodeEnv !== 'production' && nodeEnv !== 'test'
}

/**
 * The logger used when the caller passed neither `logger` nor `logLevel`:
 * console at warn level in development, noop otherwise.
 */
export function defaultLogger(): Logger {
  return isDevEnvironment() ? consoleLogger('warn') : noopLogger
}

/** Resolve the constructor's logging options into one Logger. */
export function resolveServerLogger(options: {
  logger?: Logger
  logLevel?: ServerLogLevel
}): Logger {
  if (options.logger) return options.logger
  if (options.logLevel === 'silent') return noopLogger
  if (options.logLevel) return consoleLogger(options.logLevel)
  return defaultLogger()
}
