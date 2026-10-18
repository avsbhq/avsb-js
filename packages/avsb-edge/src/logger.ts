// =====================================================================
// Default logger for the edge client (spec §1.2, breaking change B2).
//
// The edge package shipped with `noopLogger` as its default, which is why
// report 02 §5.1 and §5.2 could both be true for a year: the datafile URL
// was wrong, exposures were never fired, and a worker in production said
// absolutely nothing about either. Silence is the bug.
//
// WHERE EDGE DIFFERS FROM THE BROWSER, ON PURPOSE
//
// The browser default is console-at-warn in development and a noop in
// production, because a browser console belongs to the customer's END
// USER and SDK chatter there is noise in someone else's tab.
//
// An edge runtime has no end user. `console.warn` in a Worker goes to the
// operator's own log stream (`wrangler tail`, the Vercel/Netlify function
// log, `fastly log-tail`, CloudWatch), which is the developer. There is
// also no build step that flips a production define for a Worker, so
// "noop in production builds" has nothing to hang off. Defaulting to
// silence here would mean a wrong SDK key serves defaults to real traffic
// with nothing anywhere to explain it.
//
// So the edge default is LOUD, with a bound: configuration-level failures
// go through `logOnce`, which remembers what it has already said for the
// life of the isolate. A hot Worker handling 10k requests logs a bad key
// once, not 10k times. Set `logLevel: 'silent'` to turn everything off.
//
// HOW "DEVELOPMENT" IS DECIDED, in order. First signal that answers wins:
//
//   1. `logger` option        explicit Logger, always wins.
//   2. `logLevel` option      'silent' for a noop, or a level to force on.
//   3. `globalThis.__AVSB_DEV__`  boolean. Bundler hook:
//        wrangler  define: { __AVSB_DEV__: 'true' }
//        esbuild   --define:__AVSB_DEV__=true
//      or set `globalThis.__AVSB_DEV__ = true` in a dev entry file.
//   4. `NODE_ENV` off a real `process` object (Node on Lambda@Edge, Bun,
//      Vercel, Netlify, and every test runner). 'production' and 'test' both
//      take the deployed branch: warnings and errors still print, debug
//      detail does not, so SDK chatter stays out of a customer's test output
//      while a real misconfiguration still surfaces. Pass
//      `logLevel: 'silent'` for genuinely no output.
//   5. Anything else: development-level detail off, warnings and errors on.
//
// `process.env.NODE_ENV` is read off `globalThis` rather than as a bare
// identifier because Workers and Deno have no `process` at all, and a bare
// reference would be a ReferenceError there instead of an unknown value.
// =====================================================================

import { consoleLogger, noopLogger } from '@avsbhq/core'
import type { Logger, LogLevel } from '@avsbhq/core'

/** `logLevel` option values. 'silent' selects the noop logger. */
export type EdgeLogLevel = LogLevel | 'silent'

function readDevGlobal(): boolean | null {
  const flag = (globalThis as { __AVSB_DEV__?: unknown }).__AVSB_DEV__
  return typeof flag === 'boolean' ? flag : null
}

function readNodeEnv(): string | null {
  const proc = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> }
    }
  ).process
  const value = proc?.env?.NODE_ENV
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * True when this looks like a development environment. Exported so the
 * behaviour is directly testable and so a client can report which way it
 * resolved in a debug line.
 */
export function isDevEnvironment(): boolean {
  const explicit = readDevGlobal()
  if (explicit !== null) return explicit

  const nodeEnv = readNodeEnv()
  if (nodeEnv !== null) return nodeEnv !== 'production' && nodeEnv !== 'test'

  // No signal at all: assume a deployed Worker. Warnings and errors still
  // reach the operator's log stream, debug detail does not.
  return false
}

/**
 * The logger a client uses when the caller passed neither `logger` nor
 * `logLevel`: console at debug level in development, console at warn level
 * everywhere else. Never a noop, unlike the browser default.
 */
export function defaultLogger(): Logger {
  return isDevEnvironment() ? consoleLogger('debug') : consoleLogger('warn')
}

/** Resolve the constructor's logging options into one Logger. */
export function resolveLogger(options: {
  logger?: Logger
  logLevel?: EdgeLogLevel
}): Logger {
  if (options.logger) return options.logger
  if (options.logLevel === 'silent') return noopLogger
  if (options.logLevel) return consoleLogger(options.logLevel)
  return defaultLogger()
}

// ---------------------------------------------------------------------
// Isolate-scoped deduplication.
//
// Edge clients are constructed PER REQUEST, so per-instance "warn once"
// state (what the browser client uses) would fire on every request. This
// Set lives at module scope, which on every one of the seven runtimes
// means "for the life of this isolate or process": exactly the lifetime a
// configuration problem lasts.
//
// Bounded so a caller who feeds it unbounded keys (a per-flag-key message
// on a project with thousands of flags) cannot grow memory forever. Past
// the cap the set is cleared, which re-arms every message rather than
// silently dropping new ones.
// ---------------------------------------------------------------------

const MAX_REMEMBERED_MESSAGES = 200

const seen = new Set<string>()

/**
 * Log `message` at `level` the first time this isolate sees `key`.
 *
 * Returns true when the message was emitted, so callers can assert on the
 * dedupe rather than on console spying.
 */
export function logOnce(
  logger: Logger,
  level: Exclude<LogLevel, 'debug'>,
  key: string,
  message: string,
): boolean {
  if (seen.has(key)) return false
  if (seen.size >= MAX_REMEMBERED_MESSAGES) seen.clear()
  seen.add(key)
  logger[level](message)
  return true
}

/**
 * Forget every remembered message. Exported for tests, which must not
 * inherit dedupe state from an earlier test file in the same worker.
 */
export function resetLogOnce(): void {
  seen.clear()
}
