import { defineConfig } from 'tsup';

// Two builds, because half of this package is client code and half is not.
//
// THE BUG THIS SPLIT EXISTS TO KILL (report 03 §5 Next): the whole package
// was built as one bundle with no directive handling, and esbuild strips
// 'use client' when it bundles. The library therefore never marked its own
// client boundary: users had to write a wrapper file by hand, and any doc
// that imported the provider from a server file failed confusingly.
//
// The client entry gets the banner. The server, middleware, and pages
// entries must NOT: stamping them would make Next treat the RSC helpers as
// client code and refuse to run them.
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    target: 'es2022',
    splitting: false,
    banner: { js: "'use client'" },
    external: [
      'react',
      'next',
      '@avsbhq/core',
      '@avsbhq/browser',
      '@avsbhq/react',
      // AvsbHydrator names `BootstrapBlob` from utils. That import is
      // type-only today so nothing is emitted, but omitting utils here is
      // the kind of gap that silently inlines a second copy of the package
      // the day someone imports a value from it.
      '@avsbhq/utils',
    ],
  },
  {
    entry: ['src/server.ts', 'src/middleware.ts', 'src/pages/getServerSideProps.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    // The client build above runs first and cleans; cleaning again here
    // would delete its output.
    clean: false,
    target: 'es2022',
    splitting: false,
    external: [
      'react',
      'next',
      'next/headers',
      'next/server',
      '@avsbhq/core',
      '@avsbhq/browser',
      // `@avsbhq/node` used to be listed here and declared as a dependency.
      // No file in this package imports it: the only mentions are a docblock
      // in middleware.ts and a README snippet telling you which package to
      // reach for server-side. Both the dependency and the external entry
      // were ghosts (SDK/API DX overhaul session 9).
      '@avsbhq/react',
      '@avsbhq/utils',
    ],
  },
]);
