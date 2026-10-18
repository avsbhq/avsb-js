import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/adapters/cloudflare.ts',
    'src/adapters/vercel.ts',
    'src/adapters/fastly.ts',
    'src/adapters/netlify.ts',
    'src/adapters/deno.ts',
    'src/adapters/bun.ts',
    'src/adapters/lambdaEdge.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  external: ['@avsbhq/core', '@avsbhq/utils'],
})
