/**
 * Test helpers, published as their own entry point:
 *
 *   import { createAvsbTestContext, createTestClient } from '@avsbhq/svelte/testing'
 *
 * The context here is the REAL provider (`createAvsbContext` in Mode B). The
 * client is a REAL `AvsbClient` whose datafile is built from the flags map
 * you pass, with the network, the cache, and logging switched off. Tests then
 * exercise the same evaluator, the same snapshot caching, and the same
 * exposure rules as production instead of a mock that agrees with itself.
 *
 *   // Inside a component test (context is set on the component tree):
 *   createAvsbTestContext({ flags: { 'checkout-v2': true } })
 *
 *   // Outside a component, pass the context value to any store:
 *   const { contextValue } = createAvsbTestContext({ flags: { 'checkout-v2': true } })
 *   const store = boolFlag('checkout-v2', false, contextValue)
 *
 * `createTestDatafile` and `createTestClient` are RE-EXPORTS of the one
 * implementation in `@avsbhq/test/fixtures`. They used to be local copies,
 * one per framework package, and copies of a fixture builder drift: a test
 * could pass against one framework's idea of "a flag that is on" and fail
 * against another's. `@avsbhq/test` is a devDependency here and the subpath
 * carries no React and no mocks, so the build inlines these two functions and
 * the published tarball gains no runtime dependency.
 */
import { createTestClient, type TestClientOptions } from '@avsbhq/test/fixtures';
import { buildAvsbContext, createAvsbContext, type CreateAvsbContextResult } from './AvsbProvider';

export {
  createTestDatafile,
  createTestClient,
  type TestClientOptions,
  type TestFlags,
  type TestFlagValue,
  type CreateTestDatafileOptions,
} from '@avsbhq/test/fixtures';

/**
 * Set the real Avsb context around a real client built from a flags map.
 *
 * Call it during a component's initialisation (a test wrapper component),
 * exactly like the provider itself. Outside a component, use
 * `createTestContextValue` instead: Svelte refuses `setContext` there.
 */
export function createAvsbTestContext(options?: TestClientOptions): CreateAvsbContextResult {
  return createAvsbContext({ client: createTestClient(options) });
}

/**
 * The provider's context value, built around a real client, with nothing
 * set on Svelte's context. Pass it as the last argument to any store or
 * runes accessor to test them without a component:
 *
 *   const { contextValue } = createTestContextValue({ flags: { a: true } })
 *   const store = boolFlag('a', false, contextValue)
 */
export function createTestContextValue(options?: TestClientOptions): CreateAvsbContextResult {
  return buildAvsbContext({ client: createTestClient(options) });
}
