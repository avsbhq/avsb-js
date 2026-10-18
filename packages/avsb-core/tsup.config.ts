import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/engine.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2020',
})
