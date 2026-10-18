import { consoleLogger } from '@avsbhq/core'
import type { Logger } from '@avsbhq/core'

/**
 * Where this package writes misuse warnings.
 *
 * These are template and configuration mistakes, not data conditions: they
 * cannot appear at runtime for one visitor and not another, so they are
 * always worth printing. Runtime SDK logging (a bad key, a failed fetch, a
 * type mismatch) belongs to `@avsbhq/browser`, which routes it through the
 * logger and `logLevel` you configured on the client.
 */
export const misuseLogger: Logger = consoleLogger('warn')
