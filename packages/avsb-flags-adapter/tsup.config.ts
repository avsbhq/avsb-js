import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/adapter.ts` is the package entry, emitted as `dist/index.*` so the
  // published paths stay conventional. The repo does not use barrel files, so
  // there is no `src/index.ts` to point at.
  entry: {
    index: 'src/adapter.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2022',
  // `flags` is never imported (its adapter shape is mirrored in src/types.ts),
  // and @avsbhq/node is only ever reached through a dynamic import.
  external: ['@avsbhq/core', '@avsbhq/node'],
});
