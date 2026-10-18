import type { AvsbFlagKey, Flag } from '@avsbhq/core'
import { useAvsbContext } from './context'
import { readSnapshot, useFlagStore } from './useStoreFlag'

/**
 * Read one flag, suspending until flags are readable.
 *
 * ```ts
 * function useFlagSuspense<T>(flagKey: string, defaultValue: T): Flag<T>
 * ```
 *
 * Must be rendered inside a `<Suspense fallback={...}>` boundary. Once the
 * boundary resolves, the component renders with a real value instead of
 * the default, which is what makes the "pick the right skeleton" pattern
 * possible:
 *
 * ```tsx
 * <Suspense fallback={<Skeleton />}>
 *   <CheckoutFeature />
 * </Suspense>
 * ```
 *
 * What it suspends on is the PROVIDER leaving its loading state, not
 * `client.onReady()` directly. That matters twice: the promise exists
 * before the client does (the provider builds the client in an effect),
 * and it cannot be thrown again after it settles, so an already-resolved
 * promise can never spin the boundary.
 *
 * It does not suspend when the server already answered: if the provider
 * was given `serverFlags`, the server's value renders immediately, on the
 * server and through hydration. That includes a key the server's datafile
 * did not carry, which renders `not_found` with your default (N1-16).
 *
 * Like every rendering hook, this fires no exposure. Pair it with
 * `useExposure(flagKey)`.
 */
export function useFlagSuspense<T>(flagKey: AvsbFlagKey, defaultValue: T): Flag<T> {
  const { status, serverFlags, whenReady } = useAvsbContext()

  // `serverFlags` is every flag the server evaluated, so its presence is an
  // answer for every key: the value when it carries the key, `not_found`
  // when it does not (see useFlagStore).
  const serverAnswered = Boolean(serverFlags)

  // Hooks below must still run on every render, so this early throw comes
  // first and unconditionally: a component that suspends does not keep
  // hook state, which is exactly what React's Suspense protocol expects.
  if (status === 'loading' && !serverAnswered && whenReady) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the Suspense protocol is "throw a promise"
    throw whenReady
  }

  return useFlagStore<T>(flagKey, defaultValue, readSnapshot)
}
