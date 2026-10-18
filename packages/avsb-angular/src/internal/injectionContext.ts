import { assertInInjectionContext, inject } from '@angular/core'
import { AvsbService } from '../avsb.service'
import type { AvsbInjectOptions } from '../types'

/**
 * Resolve `AvsbService` for a standalone helper.
 *
 * With `options.injector` the helper works anywhere. Without it, the helper
 * must run in an injection context, and `assertInInjectionContext` throws
 * Angular's NG0203 naming the helper the developer actually called, rather
 * than naming `inject` or `toSignal` and sending them to the wrong docs.
 *
 * @param helper - the exported function being called, used in the error text
 */
export function resolveService(
  helper: (...args: never[]) => unknown,
  options?: AvsbInjectOptions
): AvsbService {
  const provided = options?.injector
  if (provided) return provided.get(AvsbService)
  assertInInjectionContext(helper)
  return inject(AvsbService)
}
