import { defineConfig } from 'vitest/config';

// happy-dom rather than node: the auto-import test loads @avsbhq/vue, which
// pulls in @avsbhq/browser, and the browser SDK expects a document to exist in
// the environment it is imported into. Nothing in this package renders.
//
// These tests also run under the ROOT vitest config (packages/** is included
// there), so they must pass in both runners. Build @avsbhq/core, @avsbhq/utils,
// @avsbhq/browser and @avsbhq/vue before running either: the workspace links
// resolve to each package's dist.
export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
  },
});
