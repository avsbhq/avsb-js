/**
 * Test helpers, published as their own entry point:
 *
 *   import { AvsbTestProvider, createTestClient } from '@avsbhq/solid/testing'
 *
 * The provider here is the REAL <AvsbProvider> in Mode B. The client is a
 * REAL `AvsbClient` whose datafile is built from the flags map you pass, with
 * the network, the cache, and logging switched off. Tests then exercise the
 * same evaluator, the same snapshot caching, and the same exposure rules as
 * production instead of a mock that agrees with itself.
 *
 *   render(() => (
 *     <AvsbTestProvider flags={{ 'checkout-v2': true }}>
 *       <CheckoutButton />
 *     </AvsbTestProvider>
 *   ))
 *
 * WHY THIS FILE STILL CARRIES ITS OWN COPY of `createTestDatafile` and
 * `createTestClient` when @avsbhq/vue and @avsbhq/svelte re-export the one in
 * `@avsbhq/test/fixtures`:
 *
 * This package's `./testing` subpath declares a `solid` export condition
 * pointing at THIS FILE, raw, so a consumer's `vite-plugin-solid` compiles
 * the JSX below with their own settings (pre-compiled Solid JSX from a
 * dependency is the setup Solid libraries are told to avoid). Raw source
 * shipped to a consumer can only import what the CONSUMER has installed, and
 * `@avsbhq/test` is a devDependency here, so an import of it would fail to
 * resolve in their build. Vue and Svelte have no such condition: their
 * `./testing` always resolves to bundled `dist`, where the shared helper is
 * inlined at build time.
 *
 * The duplication is therefore load-bearing, not an oversight. Closing it
 * needs a packaging decision (drop the `solid` condition from `./testing` and
 * accept pre-compiled JSX, or promote `@avsbhq/test` out of devDependencies),
 * which is flagged for the founder rather than taken silently here.
 */
import type { JSX } from 'solid-js';
import type { EvalContext } from '@avsbhq/core';
import { AvsbProvider } from './AvsbProvider';
import type { SolidAvsbClient } from './clientInterface';
import { createTestClient } from './testFixtures';

// Re-exported so `@avsbhq/solid/testing` keeps exporting all three names. They
// live in a JSX-free module because this package's own tests import them, and a
// test runner without `vite-plugin-solid` cannot read the component below.
export { createTestClient, createTestDatafile } from './testFixtures';
export type { TestClientOptions } from './testFixtures';

export interface AvsbTestProviderProps {
  flags?: Record<string, unknown>;
  context?: EvalContext;
  /** Drive the client yourself instead of passing a flags map. */
  client?: SolidAvsbClient;
  children: JSX.Element;
}

/**
 * The real provider in Mode B around a real client, so components under test
 * use the accessors they use in production.
 */
export function AvsbTestProvider(props: AvsbTestProviderProps): JSX.Element {
  const client: SolidAvsbClient =
    props.client ??
    createTestClient({
      ...(props.flags !== undefined ? { flags: props.flags } : {}),
      ...(props.context !== undefined ? { context: props.context } : {}),
    });

  return <AvsbProvider client={client}>{props.children}</AvsbProvider>;
}
