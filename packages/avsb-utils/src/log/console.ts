// Console transport. Wraps the core helper under the documented utils
// surface (`createConsoleTransport`).

import { consoleTransport } from '@avsbhq/core'
import type { LogLevel, LogTransport } from '@avsbhq/core'

export function createConsoleTransport(opts?: {
  level?: LogLevel
}): LogTransport {
  return consoleTransport(opts?.level ?? 'info')
}
