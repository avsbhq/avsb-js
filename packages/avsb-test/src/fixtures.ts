// =====================================================================
// `@avsbhq/test/fixtures` — the framework-neutral half of this package.
//
// Everything here is either pure data building or the real browser client:
// no React, no mocks, no vitest. That matters because the framework
// adapters (@avsbhq/react, @avsbhq/vue, @avsbhq/svelte, @avsbhq/solid)
// re-export these from their own `./testing` entry and bundle them at build
// time. Pointing them at the ROOT barrel instead would drag `AvsbTestProvider`
// and its React import into a Vue or Svelte tarball.
//
// The root barrel re-exports everything here too, so a direct consumer of
// `@avsbhq/test` never has to know this subpath exists.
// =====================================================================

export {
  createTestDatafile,
  TEST_SDK_KEY,
  type TestFlags,
  type TestFlagValue,
  type CreateTestDatafileOptions,
} from './fixtures/datafile';

export { createTestContext, createMultiTestContext } from './fixtures/context';

export { createTestClient, type TestClientOptions } from './createTestClient';
