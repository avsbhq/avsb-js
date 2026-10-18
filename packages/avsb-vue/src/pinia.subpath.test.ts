/**
 * Packaging guard for breaking change B9.
 *
 * The main barrel used to `export { useAvsbStore } from './pinia'`, so every
 * Vue app that did not use Pinia failed to resolve the module at dev and
 * build time. The fix is structural (its own entry point plus a properly
 * declared optional peer), so the regression test is structural too.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const packageRoot = join(__dirname, '..')

interface PackageManifest {
  exports: Record<string, unknown>
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
  dependencies: Record<string, string>
}

function manifest(): PackageManifest {
  return JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8')
  ) as PackageManifest
}

describe('@avsbhq/vue packaging', () => {
  it('publishes pinia on its own subpath with all three conditions', () => {
    // Types live INSIDE each condition, and CJS gets its own `.d.cts`: a
    // single top-level `types` would hand the ESM declarations to a CJS
    // consumer under `node16`/`nodenext` resolution.
    expect(manifest().exports['./pinia']).toEqual({
      import: {
        types: './dist/pinia.d.ts',
        default: './dist/pinia.js',
      },
      require: {
        types: './dist/pinia.d.cts',
        default: './dist/pinia.cjs',
      },
    })
  })

  it('declares pinia as an optional peer, not just a meta entry', () => {
    const pkg = manifest()
    expect(pkg.peerDependencies['pinia']).toBeDefined()
    expect(pkg.peerDependenciesMeta['pinia']?.optional).toBe(true)
    expect(pkg.dependencies['pinia']).toBeUndefined()
  })

  it('publishes the test helpers on their own subpath', () => {
    expect(manifest().exports['./testing']).toEqual({
      import: {
        types: './dist/testing.d.ts',
        default: './dist/testing.js',
      },
      require: {
        types: './dist/testing.d.cts',
        default: './dist/testing.cjs',
      },
    })
  })

  it('never pulls pinia into the main barrel', () => {
    const barrel = readFileSync(join(packageRoot, 'src', 'index.ts'), 'utf8')
    // What B9 forbids is RESOLVING './pinia' from the barrel. The header
    // comment names the subpath so readers know where the store lives, so
    // the guard matches the import/export edge, not the word.
    expect(barrel).not.toMatch(/from ['"]\.\/pinia['"]/)
    expect(barrel).not.toMatch(/import\(['"]\.\/pinia['"]\)/)
    expect(barrel).not.toContain('useAvsbStore')
  })

  it('builds an entry point per subpath', () => {
    const tsup = readFileSync(join(packageRoot, 'tsup.config.ts'), 'utf8')
    expect(tsup).toContain("pinia: 'src/pinia.ts'")
    expect(tsup).toContain("testing: 'src/testing.ts'")
  })
})
