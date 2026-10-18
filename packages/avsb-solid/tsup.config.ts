import { defineConfig } from 'tsup'

export default defineConfig({
  // The `solid` export condition points at src/, which is what Solid
  // libraries are supposed to ship: `vite-plugin-solid` compiles the JSX with
  // the app's own settings. These bundles are the fallback for toolchains
  // that do NOT understand the `solid` condition (plain Vite without the
  // plugin, node, jest), so they stay esbuild-compiled.
  entry: {
    index: 'src/index.ts',
    'solid-start': 'src/solid-start/handler.ts',
    testing: 'src/testing.tsx',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2020',
  external: [
    'solid-js',
    'solid-js/web',
    'solid-js/store',
    '@solidjs/start',
    '@avsbhq/core',
    '@avsbhq/browser',
  ],
  esbuildOptions(opts) {
    opts.jsx = 'automatic'
    opts.jsxImportSource = 'solid-js'
  },
})
