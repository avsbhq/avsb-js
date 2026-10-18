import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/jest.ts` was deleted along with its `./jest` export: it shipped a
  // preset object jest cannot consume as a preset (jest reads module.exports,
  // not a default export) and that named `ts-jest`, which this package does not
  // depend on. The README now shows the two real lines a jest user writes.
  //
  // `src/fixtures.ts` is the framework-neutral entry (datafile + context
  // builders + the real `createTestClient`, no React and no mocks). The
  // framework adapters re-export from `@avsbhq/test/fixtures` and bundle it,
  // so pointing them at the root barrel instead would inline this package's
  // React provider into a Vue or Svelte tarball.
  //
  // `src/react.ts` is the ONLY entry that reaches React, which is what makes
  // the root barrel loadable by a Vue, Svelte, or plain-Node project. A root
  // that imports React does not RESOLVE when React is absent, so shipping the
  // provider from it made "React is an optional peer" false in practice, not
  // merely wasteful.
  entry: ['src/index.ts', 'src/fixtures.ts', 'src/react.ts', 'src/vitest.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  // `@avsbhq/browser` must stay external: bundling it would ship a SECOND
  // copy of the client, so `createTestClient()` would hand back an object
  // that is not the `AvsbClient` a consumer's provider type-checks against.
  external: ['react', 'react-dom', 'vitest', '@avsbhq/core', '@avsbhq/browser', '@avsbhq/utils'],
});
