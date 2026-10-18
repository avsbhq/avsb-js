'use client';

import { createContext, useContext, useMemo, type ReactNode, type ReactElement } from 'react';
import type { EvalContext } from '@avsbhq/core';
import type { MockClient, MockClientOptions } from './mockClientTypes';
import { resolveTestClient } from './resolveTestClient';

const AvsbTestContext = createContext<MockClient | null>(null);

export interface AvsbTestProviderProps {
  /**
   * Shorthand for `options={{ flags }}`: a flagKey to value map, which is
   * what most component tests want (breaking change B26).
   *
   * ```tsx
   * <AvsbTestProvider flags={{ 'checkout-v2': true }}>
   * ```
   */
  flags?: Record<string, unknown>;
  /**
   * The evaluation context the mock is bound to. Default
   * `{ kind: 'user', key: 'test-user' }`.
   */
  context?: EvalContext;
  /** Pre-created mock client. Wins over `options`, `flags` and `context`. */
  client?: MockClient;
  /** Full createMockClient options. Wins over `flags` and `context`. */
  options?: MockClientOptions;
  children: ReactNode;
}

/**
 * React provider for test environments. Wraps children with a MockClient
 * instance so that any component consuming `useAvsbTestClient()` receives
 * a fully-controllable mock without touching the real SDK runtime.
 *
 * Usage:
 *   render(
 *     <AvsbTestProvider flags={{ 'checkout-v2': true }}>
 *       <MyComponent />
 *     </AvsbTestProvider>
 *   )
 *
 * This provides THIS package's own context, read by `useAvsbTestClient()`.
 * To drive the real `@avsbhq/react` hooks, use `AvsbTestProvider` from
 * `@avsbhq/react/testing`, which renders the real provider around a real
 * client. @avsbhq/test cannot do that itself without depending on
 * @avsbhq/react, which would invert the dependency direction.
 */
export function AvsbTestProvider({
  flags,
  context,
  client,
  options,
  children,
}: AvsbTestProviderProps): ReactElement {
  const mockClient = useMemo(
    () => resolveTestClient({ client, options, flags, context }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally stable: options/flags/context object identity is not the contract
    [client],
  );

  return <AvsbTestContext.Provider value={mockClient}>{children}</AvsbTestContext.Provider>;
}

/**
 * Retrieve the MockClient from the nearest AvsbTestProvider.
 * Throws when called outside an AvsbTestProvider.
 */
export function useAvsbTestClient(): MockClient {
  const client = useContext(AvsbTestContext);
  if (!client) {
    throw new Error(
      'useAvsbTestClient: no MockClient found. ' +
        'Ensure the component is wrapped in <AvsbTestProvider>.',
    );
  }
  return client;
}
