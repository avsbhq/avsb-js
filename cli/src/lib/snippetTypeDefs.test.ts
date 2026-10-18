import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  findSnippetTypeDefPath,
  readSnippetTypeDefs,
  snippetTypeDefCandidates,
  SNIPPET_TYPE_DEF_FILES,
  typeDefBanner,
  type TypeDefLookup,
} from './snippetTypeDefs.js'

const MODULE_DIR = '/app/cli/dist'

describe('snippetTypeDefCandidates', () => {
  it('looks beside the built CLI first, which is what a published install has', () => {
    const candidates = snippetTypeDefCandidates('avsb.d.ts', {
      moduleDir: MODULE_DIR,
      packageDir: () => null,
    })

    expect(candidates[0]).toBe(path.join(MODULE_DIR, 'types', 'avsb.d.ts'))
  })

  it('tries the installed package next when one is resolvable', () => {
    const candidates = snippetTypeDefCandidates('avsb.d.ts', {
      moduleDir: MODULE_DIR,
      packageDir: () => '/app/node_modules/@avsbhq/snippet-types',
    })

    expect(candidates[1]).toBe('/app/node_modules/@avsbhq/snippet-types/avsb.d.ts')
  })

  it('walks up for the monorepo copy, which is what development and tests read', () => {
    const candidates = snippetTypeDefCandidates('avsb.d.ts', {
      moduleDir: MODULE_DIR,
      packageDir: () => null,
      isRepoRoot: (dir) => dir === '/app',
    })

    expect(candidates).toContain('/app/packages/avsb-snippet-types/avsb.d.ts')
  })

  it('searches the repository root and then stops, never above it', () => {
    const candidates = snippetTypeDefCandidates('avsb.d.ts', {
      moduleDir: '/home/dev/work/repo/cli/dist',
      packageDir: () => null,
      isRepoRoot: (dir) => dir === '/home/dev/work/repo',
    })

    expect(candidates).toContain('/home/dev/work/repo/packages/avsb-snippet-types/avsb.d.ts')
    expect(candidates).not.toContain('/home/dev/work/packages/avsb-snippet-types/avsb.d.ts')
    expect(candidates).not.toContain('/home/packages/avsb-snippet-types/avsb.d.ts')
  })

  it('stops at the filesystem root when there is no repository at all', () => {
    const candidates = snippetTypeDefCandidates('avsb.d.ts', {
      moduleDir: '/',
      packageDir: () => null,
      isRepoRoot: () => false,
    })

    expect(candidates.length).toBeLessThan(5)
  })
})

describe('findSnippetTypeDefPath', () => {
  function lookup(existing: string[]): TypeDefLookup {
    return {
      moduleDir: MODULE_DIR,
      packageDir: () => '/app/node_modules/@avsbhq/snippet-types',
      exists: (candidate) => existing.includes(candidate),
    }
  }

  it('returns the first candidate that exists', () => {
    const found = findSnippetTypeDefPath(
      'avsb.d.ts',
      lookup([
        '/app/node_modules/@avsbhq/snippet-types/avsb.d.ts',
        path.join(MODULE_DIR, 'types', 'avsb.d.ts'),
      ]),
    )

    expect(found).toBe(path.join(MODULE_DIR, 'types', 'avsb.d.ts'))
  })

  it('returns null when no copy is anywhere, rather than inventing one', () => {
    expect(findSnippetTypeDefPath('avsb.d.ts', lookup([]))).toBeNull()
  })
})

describe('readSnippetTypeDefs', () => {
  it('fails loudly, naming the package, when the declarations are missing', () => {
    expect(() =>
      readSnippetTypeDefs({
        moduleDir: MODULE_DIR,
        packageDir: () => null,
        exists: () => false,
      }),
    ).toThrow(/@avsbhq\/snippet-types/)
  })

  it('reads the real published files from this repository', () => {
    // No injection: this asserts the shipped resolution chain finds the
    // monorepo copy, which is the whole point of not pasting the types here.
    const files = readSnippetTypeDefs()

    expect(files.map((file) => file.filename)).toEqual([...SNIPPET_TYPE_DEF_FILES])
    const avsb = files[0].contents
    // APIs the CLI's old hand-written copy was missing entirely.
    expect(avsb).toContain('interface AvsbApi')
    expect(avsb).toContain('purchase')
    expect(avsb).toContain('consent')
    expect(files[1].contents).toContain('declare function initVariation')
  })
})

describe('typeDefBanner', () => {
  it('marks the file as a copy and names its source', () => {
    const banner = typeDefBanner('avsb.d.ts')

    expect(banner).toContain('@avsbhq/snippet-types/avsb.d.ts')
    expect(banner).toContain('Do not edit')
  })
})
