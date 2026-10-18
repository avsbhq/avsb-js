import { useMemo, type ReactElement, type ReactNode } from 'react'
import { AvsbClient } from '@avsbhq/browser'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'
import { AvsbProvider } from '../AvsbProvider'
import { createTestDatafile } from './createTestDatafile'
import type { TestFlags } from './createTestDatafile'

/**
 * Props for `<AvsbTestProvider>`.
 */
export interface AvsbTestProviderProps {
  /**
   * Flag key to value. Every flag listed serves that value to every
   * visitor.
   *
   * ```tsx
   * <AvsbTestProvider flags={{ 'checkout-v2': true }}>
   * ```
   */
  flags?: TestFlags
  /** A full datafile, when a map of values is not expressive enough. */
  datafile?: FlagDatafile
  /** Evaluation context. Default `{ kind: 'user', key: 'test-user' }`. */
  context?: EvalContext
  children: ReactNode
}

const DEFAULT_CONTEXT: EvalContext = { kind: 'user', key: 'test-user' }

/**
 * Wrap a component under test with a REAL provider and a REAL client.
 *
 * ```tsx
 * import { AvsbTestProvider } from '@avsbhq/react/testing'
 *
 * render(
 *   <AvsbTestProvider flags={{ 'checkout-v2': true }}>
 *     <CheckoutButton />
 *   </AvsbTestProvider>,
 * )
 * ```
 *
 * There is no mock client here on purpose. The flags map becomes a real
 * datafile, the real `AvsbClient` bootstraps from it, and the real
 * `AvsbProvider` owns it, so your test exercises the store contract, the
 * runtime type checks, and `isEnabled()` exactly as production does. A
 * hand-written mock is what let a whole release ship with hooks that
 * could not render a flag.
 *
 * The client is offline by construction: no polling, no localStorage
 * cache, no logging, and the datafile is already in memory, so flags are
 * readable on the first render with no `await`.
 */
export function AvsbTestProvider({
  flags,
  datafile,
  context,
  children,
}: AvsbTestProviderProps): ReactElement {
  const bootstrap = useMemo(
    () => datafile ?? createTestDatafile(flags ?? {}),
    [datafile, flags],
  )

  return (
    <AvsbProvider
      sdkKey={bootstrap.sdkKey}
      context={context ?? DEFAULT_CONTEXT}
      bootstrap={bootstrap}
      autoRefresh={false}
      cache={false}
      logLevel="silent"
    >
      {children}
    </AvsbProvider>
  )
}

/**
 * Build the same client the test provider builds, for tests that need the
 * client directly (asserting on `track` calls, driving `identify`).
 *
 * ```ts
 * const client = createTestClient({ 'checkout-v2': true })
 * expect(client.getBoolFlag('checkout-v2', false).value).toBe(true)
 * ```
 */
export function createTestClient(
  flags?: TestFlags,
  options?: { datafile?: FlagDatafile; context?: EvalContext },
): AvsbClient {
  const bootstrap = options?.datafile ?? createTestDatafile(flags ?? {})
  return new AvsbClient({
    sdkKey: bootstrap.sdkKey,
    context: options?.context ?? DEFAULT_CONTEXT,
    bootstrap,
    autoRefresh: false,
    cache: false,
    logLevel: 'silent',
  })
}
