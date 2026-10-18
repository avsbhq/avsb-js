import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'node18',
  // `dependencies` are external by default. The old `external: ['@avsbhq/js']`
  // entry named a package this one never imported and that no longer exists.
  external: ['@avsbhq/core', '@avsbhq/utils'],
})
