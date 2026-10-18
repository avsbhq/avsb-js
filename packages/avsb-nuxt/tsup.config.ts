import { defineConfig } from 'tsup';

// ESM only: Nuxt 3 and 4 load modules as ESM, so a .cjs twin (and the .d.cts
// that would have to come with it) would ship bytes nothing loads.
//
// `runtime/plugin` is built here alongside the two public entries rather than
// in a second config, so there is one `clean` and one shared chunk graph: the
// plugin's `await import('../server')` resolves to the same server chunk the
// `./server` entry exports, instead of a private copy.
//
// Its `#app` import (Nuxt's virtual module, which only exists inside a Nuxt
// build) stays external, and the declarations it emits never mention it,
// because `defineNuxtPlugin` is typed as returning `unknown` in the local
// dev-only shim at src/types/nuxt-app.d.ts.
export default defineConfig({
  entry: {
    module: 'src/module.ts',
    server: 'src/server.ts',
    'runtime/plugin': 'src/runtime/plugin.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  target: 'es2022',
  external: [
    '@nuxt/kit',
    '@nuxt/schema',
    'nuxt',
    'vue',
    '#app',
    '@avsbhq/core',
    '@avsbhq/browser',
    '@avsbhq/browser/server',
    '@avsbhq/vue',
  ],
});
