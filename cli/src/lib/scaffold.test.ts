import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { refreshTypeDefinitions, writeTypeDefinitions } from './scaffold.js'
import { SNIPPET_TYPE_DEF_FILES } from './snippetTypeDefs.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avsb-scaffold-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function read(filename: string): string {
  return fs.readFileSync(path.join(dir, filename), 'utf-8')
}

describe('writeTypeDefinitions', () => {
  it('writes both published declaration files, banner first', () => {
    const written = writeTypeDefinitions(dir)

    expect(written).toEqual([...SNIPPET_TYPE_DEF_FILES])
    expect(read('avsb.d.ts')).toContain('Copied by @avsbhq/cli')
    expect(read('variation-code.d.ts')).toContain('declare function initTrigger')
  })

  it('writes the real API surface, not a summary of it', () => {
    writeTypeDefinitions(dir)

    // Members the CLI's old hand-written copy never had.
    const contents = read('avsb.d.ts')
    expect(contents).toContain('purchase')
    expect(contents).toContain('recs')
    expect(contents).toContain('consent')
  })
})

describe('refreshTypeDefinitions', () => {
  it('does nothing for a JavaScript folder, which has no declarations', () => {
    expect(refreshTypeDefinitions(dir, 'js')).toEqual([])
    expect(fs.existsSync(path.join(dir, 'avsb.d.ts'))).toBe(false)
  })

  it('reports nothing when the files on disk are already current', () => {
    writeTypeDefinitions(dir)

    expect(refreshTypeDefinitions(dir, 'ts')).toEqual([])
  })

  it('rewrites a stale copy, so an old folder picks up newer APIs', () => {
    fs.writeFileSync(path.join(dir, 'avsb.d.ts'), '// an old, hand-edited copy\n')

    const changed = refreshTypeDefinitions(dir, 'ts')

    expect(changed).toContain('avsb.d.ts')
    expect(read('avsb.d.ts')).toContain('Copied by @avsbhq/cli')
  })

  it('creates a missing file rather than skipping it', () => {
    writeTypeDefinitions(dir)
    fs.rmSync(path.join(dir, 'variation-code.d.ts'))

    expect(refreshTypeDefinitions(dir, 'ts')).toEqual(['variation-code.d.ts'])
  })
})
