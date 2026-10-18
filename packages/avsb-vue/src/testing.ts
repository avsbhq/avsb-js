/**
 * Test helpers, published as their own entry point:
 *
 *   import { AvsbTestProvider, createTestClient } from '@avsbhq/vue/testing'
 *
 * The provider here is the REAL <AvsbProvider> in Mode B. The client is a
 * REAL `AvsbClient` whose datafile is built from the flags map you pass, with
 * the network, the cache, and logging switched off. That means your tests
 * exercise the same evaluator, the same snapshot caching, and the same
 * exposure rules as production, instead of a mock that agrees with itself.
 *
 *   mount(MyComponent, {
 *     global: {
 *       components: { AvsbTestProvider },
 *     },
 *   })
 *
 *   // or drive the client directly
 *   const client = createTestClient({ flags: { 'checkout-v2': true } })
 *   expect(client.getBoolFlag('checkout-v2', false).isEnabled()).toBe(true)
 *
 * `createTestDatafile` and `createTestClient` are RE-EXPORTS of the one
 * implementation in `@avsbhq/test/fixtures`. They used to be local copies,
 * one per framework package, and copies of a fixture builder drift: a test
 * could pass against one framework's idea of "a flag that is on" and fail
 * against another's. `@avsbhq/test` is a devDependency here and the subpath
 * carries no React and no mocks, so the build inlines these two functions and
 * the published tarball gains no runtime dependency.
 */
import { defineComponent, h, type PropType } from 'vue';
import { createTestClient, type TestFlags } from '@avsbhq/test/fixtures';
import type { EvalContext } from '@avsbhq/core';
import { AvsbProvider } from './AvsbProvider';
import type { VueAvsbClient } from './clientInterface';

export {
  createTestDatafile,
  createTestClient,
  type TestClientOptions,
  type TestFlags,
  type TestFlagValue,
  type CreateTestDatafileOptions,
} from '@avsbhq/test/fixtures';

/**
 * `<AvsbTestProvider :flags="{ 'checkout-v2': true }">` mounts the real
 * provider around a real client, so the components under test use the
 * composables they use in production.
 *
 * Pass `client` instead of `flags` to drive the client yourself.
 */
export const AvsbTestProvider = defineComponent({
  name: 'AvsbTestProvider',

  props: {
    flags: {
      type: Object as PropType<TestFlags>,
      default: undefined,
    },
    context: {
      type: Object as PropType<EvalContext>,
      default: undefined,
    },
    client: {
      type: Object as PropType<VueAvsbClient>,
      default: undefined,
    },
  },

  setup(props, { slots }) {
    const client: VueAvsbClient =
      props.client ??
      createTestClient({
        ...(props.flags !== undefined ? { flags: props.flags } : {}),
        ...(props.context !== undefined ? { context: props.context } : {}),
      });

    return () => h(AvsbProvider, { client }, { default: () => slots.default?.() });
  },
});
