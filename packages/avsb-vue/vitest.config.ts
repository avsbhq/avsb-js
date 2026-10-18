import { defineConfig } from 'vitest/config'

// No @vitejs/plugin-vue: nothing under test imports an SFC. The provider that
// ships is `AvsbProvider.ts` (a defineComponent), and the composable tests run
// inside an `effectScope` with no component at all, so the suite needs the
// plain TypeScript pipeline and a DOM for the SDK's storage APIs.
export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
  },
})
