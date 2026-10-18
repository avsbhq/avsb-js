import { InjectionToken } from '@angular/core'
import type { AvsbConfig } from './types'
import type { AngularAvsbClient } from './clientInterface'

/**
 * The `AvsbConfig` passed to `provideAvsb()` or `AvsbModule.forRoot()`.
 * Injectable if you need to read back the configuration you supplied.
 */
export const AVSB_CONFIG = new InjectionToken<AvsbConfig>('AVSB_CONFIG')

/**
 * The resolved client. Inject it for the raw SDK surface (runtime overrides,
 * `getContext`, `updateAttributes`); prefer `AvsbService` for flag reads,
 * which are render-safe and exposure-free.
 *
 * ```ts
 * private readonly client = inject(AVSB_CLIENT)
 * ```
 */
export const AVSB_CLIENT = new InjectionToken<AngularAvsbClient>('AVSB_CLIENT')
