import { defineConfig } from 'vitest/config'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  resolve: {
    // Ensure solid-js resolves to the browser (reactive) build, not server (SSR) build.
    // The 'solid' condition is exported in solid-js package.json for the browser runtime.
    conditions: ['solid', 'browser', 'import', 'default'],
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    deps: {
      optimizer: {
        web: {
          // Inline solid-js so the reactive runtime is transformed by vite-plugin-solid
          // and the single reactive owner context is shared across tests.
          include: ['solid-js'],
        },
      },
    },
  },
})
