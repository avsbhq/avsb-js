// =====================================================================
// `@avsbhq/test/react` — the React half of this package.
//
// It is a separate entry point because the root barrel must not import
// React. `AvsbTestProvider` used to live on the root, so
// `import { createMockClient } from '@avsbhq/test'` pulled React into the
// module graph of a Vue, Svelte, or plain-Node project. With React absent
// that import does not resolve at all, which made the README's "React is an
// optional peer" claim false at the resolution level rather than merely
// wasteful.
//
// Nothing else moved: the mocks, the fixture builders, `createTestClient`,
// `TestData` and the recorders all stay on the root, and `resolveTestClient`
// (the provider's precedence rule, which touches no React) stays there too.
// =====================================================================

export {
  AvsbTestProvider,
  useAvsbTestClient,
  type AvsbTestProviderProps,
} from './AvsbTestProvider';
