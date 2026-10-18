import { defineConfig } from 'vitest/config';

// Node environment: this adapter only ever runs on a server (Next middleware,
// route handlers, Server Components). Nothing here touches a DOM.
//
// These tests also run under the ROOT vitest config (packages/** is included
// there, which uses happy-dom), so they must pass in both. Build @avsbhq/core
// first: the workspace link resolves to its dist.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
