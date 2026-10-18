import { defineConfig } from 'tsup'

// Everything this package exports is a client component or a hook, so both
// entries carry the 'use client' banner. esbuild strips directives when it
// bundles, which is why the library never marked its own client boundary
// and Next users had to write a wrapper file by hand (report 03 §5).
//
// `@avsbhq/js` used to be listed as an external. That package does not
// exist any more; the entry was a ghost from an earlier layout.
export default defineConfig({
  entry: ['src/index.ts', 'src/testing.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2020',
  banner: { js: "'use client'" },
  external: ['react', '@avsbhq/core', '@avsbhq/browser'],
})
