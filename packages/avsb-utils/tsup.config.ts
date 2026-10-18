import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/openfeature.ts',
    'src/log/pino.ts',
    'src/log/winston.ts',
    'src/log/console.ts',
    'src/middleware/express.ts',
    'src/middleware/fastify.ts',
    'src/middleware/hono.ts',
    'src/middleware/koa.ts',
    'src/middleware/nextApp.ts',
    'src/middleware/nextPages.ts',
    'src/middleware/lambda.ts',
    'src/middleware/workers.ts',
    'src/streaming.ts',
    // Zero-dependency leaf subpaths (`@avsbhq/utils/backoff`,
    // `@avsbhq/utils/sdkKey`, `@avsbhq/utils/exposure`). Deliberately NOT
    // re-exported from the root: every runtime, including the browser, imports
    // them directly so they never drag the root chunk (warehouse sinks and
    // all) into a bundle.
    'src/backoff.ts',
    'src/sdkKey.ts',
    'src/exposure.ts',
    // Browser-safe leaves (`@avsbhq/utils/snapshot`,
    // `@avsbhq/utils/createUtils`). Same rule as the three above: the browser
    // client needs `createSnapshotStore` and `createUtils` at RUNTIME, and
    // reaching them through the root barrel pulled `node:async_hooks` and the
    // file-bootstrap `fs` import into every customer's web bundle, which no
    // browser bundler can resolve.
    'src/snapshot.ts',
    'src/createUtils.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2022',
  splitting: false,
  external: [
    'zod',
    'pino',
    'winston',
    'express',
    'fastify',
    'hono',
    'koa',
    'next',
    '@openfeature/server-sdk',
    '@openfeature/web-sdk',
    '@avsbhq/core',
    '@avsbhq/node',
    '@avsbhq/browser',
  ],
})
