import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    sveltekit: 'src/sveltekit/hooks.ts',
    testing: 'src/testing.ts',
    // `src/runes/flags.svelte.ts` is deliberately NOT built: runes have to be
    // compiled by the consuming app's Svelte compiler, so that entry point
    // ships as source (see the `./runes` export and `files`).
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2020',
  external: ['svelte', 'svelte/store', '@sveltejs/kit', '@avsbhq/core', '@avsbhq/browser'],
})
