/**
 * Harness for this package's own tests. Not part of any entry point and not
 * published (`files` ships `dist` only).
 *
 * Composables are run inside an `effectScope` with an app-level provide, so
 * the tests exercise the real composables with no component, no DOM, and no
 * render assertions: `scope.stop()` is the same disposal path a component
 * unmount takes.
 */
import { createApp, effectScope, type App, type EffectScope } from 'vue'
import { AvsbInjectionKey } from './context'
import type { AvsbContextValue } from './context'
import type { VueAvsbClient } from './clientInterface'
import type { AvsbStatus } from './types'

export interface RunResult<T> {
  result: T
  /** Dispose the scope, which unsubscribes everything the composable set up. */
  stop: () => void
}

export function contextValue(
  client: VueAvsbClient,
  overrides?: Partial<Omit<AvsbContextValue, 'client'>>
): AvsbContextValue {
  return {
    client,
    status: (overrides?.status ?? 'ready') as AvsbStatus,
    error: overrides?.error,
    degraded: overrides?.degraded ?? false,
  }
}

/** Run a composable with a provider context in scope. */
export function runComposable<T>(
  context: AvsbContextValue,
  composable: () => T
): RunResult<T> {
  const app: App = createApp({ render: () => null })
  app.provide(AvsbInjectionKey, context)

  const scope: EffectScope = effectScope()
  const result = scope.run(() => app.runWithContext(composable))

  return {
    result: result as T,
    stop: () => scope.stop(),
  }
}
