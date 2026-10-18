import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  external: [
    'react',
    'react-native',
    '@react-native-async-storage/async-storage',
    '@avsbhq/core',
    '@avsbhq/browser',
    '@avsbhq/react',
    '@avsbhq/utils',
  ],
})
