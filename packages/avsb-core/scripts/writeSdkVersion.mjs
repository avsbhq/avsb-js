// =====================================================================
// Write src/version.ts for the JavaScript SDK package in the current
// working directory, from that package's own package.json (N0-9, N1-14).
//
// Every SDK reports `sdkType` and `sdkVersion` on its liveness heartbeat,
// and the Environments page shows them. They were hand-maintained literals
// and drifted: @avsbhq/node 1.7.2 reported 1.7.1, edge 1.1.1 reported 1.1.0,
// and every framework package reported "@avsbhq/browser". Each SDK package
// runs this as its `prebuild` script, so a build can never ship a version
// that disagrees with package.json, and each package's version.test.ts fails
// when the committed file was not regenerated after a bump.
//
// Usage, from a package directory (npm runs scripts there):
//   node ../avsb-core/scripts/writeSdkVersion.mjs
// =====================================================================

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const packageDir = process.cwd()
const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SCOPED_NAME = /^@avsbhq\/[a-z0-9-]+$/

if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version)) {
  throw new Error(`writeSdkVersion: ${packageDir}/package.json has no valid "version".`)
}
if (typeof pkg.name !== 'string' || !SCOPED_NAME.test(pkg.name)) {
  throw new Error(`writeSdkVersion: ${packageDir}/package.json "name" is not an @avsbhq package.`)
}

const contents = `// GENERATED from package.json by packages/avsb-core/scripts/writeSdkVersion.mjs,
// which runs as this package's \`prebuild\`. Do not edit by hand: change
// "version" in package.json and run \`npm run build\` (or the script). The
// colocated version.test.ts fails while the two disagree.

/** This package's version, reported on every liveness heartbeat as \`sdkVersion\`. */
export const SDK_VERSION = '${pkg.version}'

/** This package's name exactly as published, reported as \`sdkType\`. */
export const SDK_TYPE = '${pkg.name}'
`

writeFileSync(join(packageDir, 'src', 'version.ts'), contents, 'utf8')
process.stdout.write(`wrote src/version.ts: ${pkg.name} ${pkg.version}\n`)
