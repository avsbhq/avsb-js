// =====================================================================
// Default logger for the browser client (spec §1.2, breaking change B2).
//
// Until this landed the browser SDK defaulted to `noopLogger`, so a
// typo'd SDK key produced NOTHING: no throw, no console line, and (before
// B1) `success: true`. The first experience of the product was silence.
//
// The default is now a console transport at WARN level in development and
// a noop everywhere else, so the SDK is loud exactly where a developer is
// watching and silent in a customer's production traces.
//
// HOW "DEVELOPMENT" IS DECIDED, in order. The first signal that answers
// wins, and every one of them is overridable:
//
//   1. `logger` option        explicit Logger, always wins.
//   2. `logLevel` option      'silent' for a noop, or a level to force on.
//   3. `globalThis.__AVSB_DEV__`  boolean. This is the bundler hook:
//        Vite     define: { __AVSB_DEV__: 'import.meta.env.DEV' }
//        webpack  new DefinePlugin({ __AVSB_DEV__: 'process.env.NODE_ENV !== "production"' })
//      or just set `window.__AVSB_DEV__ = true` in a dev entry file.
//   4. `NODE_ENV` when a real `process` object exists (Node, jsdom and
//      happy-dom test runners, SSR): 'production' is silent, 'test' is
//      silent (a test runner is not a developer watching a console, and
//      SDK diagnostics would pollute a customer's test output), anything
//      else is development.
//   5. Local-host heuristic: localhost, 127.0.0.1, [::1], *.localhost,
//      *.local, and RFC1918 LAN addresses count as development. This is
//      the case NODE_ENV cannot cover: in a Vite dev server, browser code
//      has no `process` at all, so without this a developer running
//      `vite dev` would get the silent production logger.
//   6. Anything else is treated as production, and stays silent.
//
// Two deliberate non-uses:
//
// `import.meta.env.DEV` is NOT read directly. This source is bundled to
// CJS as well as ESM, and `import.meta` in a CJS output is a build-time
// warning that evaluates to an empty object, while the alternative
// (reading it through `new Function`) is eval and would break any
// customer running a strict Content Security Policy. Signal 3 gives
// bundler users the same result with one line of config.
//
// `process.env.NODE_ENV` is read off `globalThis`, not as a bare member
// expression, because a bare `process` identifier does not typecheck in a
// browser package (no @types/node) and a browser bundle that never had
// `process` substituted would throw a ReferenceError. The cost is that
// bundler string-replacement of `process.env.NODE_ENV` does not reach
// signal 4, which is what signals 3 and 5 exist to cover.
// =====================================================================

import { consoleLogger, noopLogger } from '@avsbhq/core'
import type { Logger, LogLevel } from '@avsbhq/core'

/** `logLevel` option values. 'silent' selects the noop logger. */
export type BrowserLogLevel = LogLevel | 'silent'

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /^127(?:\.\d{1,3}){3}$/,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^10(?:\.\d{1,3}){3}$/,
  /^192\.168(?:\.\d{1,3}){2}$/,
  /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/,
]

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

function isPrivateHost(): boolean {
  if (typeof location === 'undefined') return false
  const host = location.hostname
  if (!host) return false
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))
}

/**
 * True when this looks like a development environment. Exported so the
 * client can report which signal it used in a debug line, and so the
 * behaviour is directly testable.
 */
export function isDevEnvironment(): boolean {
  const explicit = readDevGlobal()
  if (explicit !== null) return explicit

  const nodeEnv = readNodeEnv()
  if (nodeEnv !== null) {
    if (nodeEnv === 'production' || nodeEnv === 'test') return false
    return true
  }

  return isPrivateHost()
}

/**
 * The logger a client uses when the caller passed neither `logger` nor
 * `logLevel`: console at warn level in development, noop otherwise.
 */
export function defaultLogger(): Logger {
  return isDevEnvironment() ? consoleLogger('warn') : noopLogger
}

/** Resolve the constructor's logging options into one Logger. */
export function resolveLogger(options: {
  logger?: Logger
  logLevel?: BrowserLogLevel
}): Logger {
  if (options.logger) return options.logger
  if (options.logLevel === 'silent') return noopLogger
  if (options.logLevel) return consoleLogger(options.logLevel)
  return defaultLogger()
}
