import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    // Pin the root to cli/ so `include` resolves here no matter where the run
    // starts. Without it, `npx vitest run --config cli/vitest.config.ts` from
    // the repo root looks for `src/**/*.test.ts` at the repo root and collects
    // nothing. Mirrors snippet/vitest.config.ts.
    root: path.resolve(__dirname),
    globals: true,
    environment: 'node',
    // build.test.mjs builds the bundle and starts it: the one test that runs
    // what npm ships rather than the TypeScript sources.
    include: ['src/**/*.test.ts', 'build.test.mjs'],
    exclude: ['node_modules', 'dist'],
  },
})
