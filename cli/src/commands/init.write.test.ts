import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectFramework, type PackageJsonLike } from '../lib/frameworkDetect.js'
import { buildFrameworkProfile, type FrameworkProfile } from '../lib/frameworkProfiles.js'
import {
  exampleFileExists,
  listDirectory,
  readFileOrNull,
  resolveExamplePath,
  writeExampleFile,
} from './init.write.js'

const SDK_KEY = 'sdk_production_ttqm0eaj4vth1krcb2xn'

function profileFor(pkg: PackageJsonLike | null): FrameworkProfile {
  return buildFrameworkProfile(detectFramework(pkg))
}

const nextProfile = profileFor({ dependencies: { next: '16.0.0' } })
const vueProfile = profileFor({ dependencies: { vue: '3.5.0' }, devDependencies: { vite: '6.0.0' } })
const siteProfile = profileFor(null)

describe('writeExampleFile', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avsb-init-example-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function write(profile: FrameworkProfile, overridePath?: string) {
    return writeExampleFile({
      dir,
      profile,
      flagKey: 'checkout_v2',
      sdkKey: SDK_KEY,
      environmentKey: 'production',
      overridePath,
    })
  }

  it('writes the example where the profile says, with the real flag key in it', () => {
    const result = write(nextProfile)

    expect(result.wrote).toBe(true)
    expect(result.existed).toBe(false)
    expect(result.filePath).toBe(path.join(dir, 'avsb-example.tsx'))
    expect(fs.readFileSync(result.filePath, 'utf-8')).toContain("useBoolFlag('checkout_v2'")
  })

  it('never overwrites a file that is already there', () => {
    // The guard that matters most: a re-run must not eat work the developer put
    // in the file the first run created.
    const filePath = path.join(dir, 'avsb-example.tsx')
    const mine = 'export const mine = "hand written"\n'
    fs.writeFileSync(filePath, mine, 'utf-8')

    const result = write(nextProfile)

    expect(result.wrote).toBe(false)
    expect(result.existed).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(mine)
  })

  it('creates the directory the example lives in', () => {
    const result = write(vueProfile)

    expect(result.filePath).toBe(path.join(dir, 'src', 'AvsbExample.vue'))
    expect(result.wrote).toBe(true)
    expect(fs.existsSync(path.join(dir, 'src'))).toBe(true)
  })

  it('honours an explicit path, including one in a directory that does not exist', () => {
    const result = write(nextProfile, 'app/examples/flag-demo.tsx')

    expect(result.filePath).toBe(path.join(dir, 'app', 'examples', 'flag-demo.tsx'))
    expect(fs.existsSync(result.filePath)).toBe(true)
  })

  it('writes nothing at all for a profile with no sample to write', () => {
    // No package.json means the web snippet path, where the CLI has no example
    // to hand over. It must not leave an empty file behind.
    const result = write(siteProfile)

    expect(result.wrote).toBe(false)
    expect(result.existed).toBe(false)
    expect(fs.existsSync(result.filePath)).toBe(false)
    expect(listDirectory(dir)).toEqual([])
  })

  it('reports an existing file through exampleFileExists, override included', () => {
    expect(exampleFileExists(dir, nextProfile)).toBe(false)

    fs.writeFileSync(resolveExamplePath(dir, nextProfile), 'x', 'utf-8')
    fs.writeFileSync(path.join(dir, 'other.tsx'), 'x', 'utf-8')

    expect(exampleFileExists(dir, nextProfile)).toBe(true)
    expect(exampleFileExists(dir, nextProfile, 'other.tsx')).toBe(true)
    expect(exampleFileExists(dir, nextProfile, 'missing.tsx')).toBe(false)
  })
})

describe('readFileOrNull and listDirectory', () => {
  it('answer null and empty rather than throwing on a path that is not there', () => {
    const missing = path.join(os.tmpdir(), 'avsb-init-not-here', 'package.json')

    expect(readFileOrNull(missing)).toBeNull()
    expect(listDirectory(path.dirname(missing))).toEqual([])
  })

  it('reads a file that is there', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avsb-init-read-'))
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}', 'utf-8')

      expect(readFileOrNull(path.join(dir, 'package.json'))).toBe('{"name":"app"}')
      expect(listDirectory(dir)).toEqual(['package.json'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads a directory as a list of names, not paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avsb-init-list-'))
    try {
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '', 'utf-8')

      expect(listDirectory(dir)).toEqual(['pnpm-lock.yaml'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
