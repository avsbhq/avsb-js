import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outfile = join(__dirname, 'dist', 'cli.js')

await build({
  // Paths resolve from cli/, so `node cli/build.mjs` from the repository root
  // builds the same bundle as `npm run build` inside cli/.
  absWorkingDir: __dirname,
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: ['node18'],
  format: 'esm',
  outfile,
  external: ['esbuild', 'sass', 'fsevents'],
  banner: {
    // esbuild pastes the banner above the bundle without renaming anything around
    // it, so a banner binding that a bundled file also imports is declared twice,
    // which is a SyntaxError before the first line runs. That is how 3.7.0 and
    // 3.8.1 shipped unable to start: lib/snippetTypeDefs.ts imports
    // `createRequire` too. The import is aliased to a name no source file uses.
    // `require` itself keeps its name: esbuild's shim for bundled CommonJS
    // dependencies looks for a global called exactly that.
    js: [
      '#!/usr/bin/env node',
      'import { createRequire as __cliCreateRequire } from "node:module";',
      'const require = __cliCreateRequire(import.meta.url);',
    ].join('\n'),
  },
})

// Scaffolded folders get the REAL published declarations, so the published CLI
// has to carry them. They are read from disk at runtime (see
// lib/snippetTypeDefs.ts) rather than bundled, so copy them next to the bundle.
// A missing source is a hard failure: a CLI whose `avsb clone` writes no type
// definitions is worse than a build that stops here.
const TYPE_DEFS = ['avsb.d.ts', 'variation-code.d.ts']
const typesSourceDir = resolve(__dirname, '..', 'packages', 'avsb-snippet-types')
const typesOutDir = join(__dirname, 'dist', 'types')
mkdirSync(typesOutDir, { recursive: true })

for (const file of TYPE_DEFS) {
  const source = join(typesSourceDir, file)
  if (!existsSync(source)) {
    process.stderr.write(`Missing ${source}. @avsbhq/snippet-types is the source of truth for ${file}.\n`)
    process.exit(1)
  }
  copyFileSync(source, join(typesOutDir, file))
}

// Start the bundle once before calling the build good. `prepublishOnly` runs
// this file, so a bundle that cannot start can never reach npm again; the
// smoke test in build.test.mjs runs the same check under vitest.
const { version } = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'))
let printed = ''
try {
  printed = execFileSync(process.execPath, [outfile, '--version'], {
    encoding: 'utf-8',
    env: { ...process.env, AVSB_NO_UPDATE_NOTIFIER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
} catch (error) {
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
  process.stderr.write(`The built CLI does not start: \`node dist/cli.js --version\` failed.\n${stderr}\n`)
  process.exit(1)
}
if (printed !== version) {
  process.stderr.write(`The built CLI printed "${printed}" for --version, expected "${version}".\n`)
  process.exit(1)
}

process.stdout.write(
  `Built cli/dist/cli.js (${version}, starts on Node ${process.versions.node}) and copied ${TYPE_DEFS.length} type definition files\n`,
)
