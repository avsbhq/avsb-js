import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    // Its own entry point so the main barrel never imports pinia (B9).
    pinia: 'src/pinia.ts',
    testing: 'src/testing.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2020',
  external: ['vue', 'pinia', '@avsbhq/core', '@avsbhq/browser'],
})
