// N0-9 / N1-14 (production QA 2026-10-01): heartbeats reported versions
// that lagged package.json (node 1.7.2 sent 1.7.1, edge 1.1.1 sent 1.1.0).
// src/version.ts is now generated from package.json by the prebuild script;
// this fails when a version bump was committed without regenerating it.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SDK_TYPE, SDK_VERSION } from './version'

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
) as { name: string; version: string }

describe('SDK identity reported on the heartbeat', () => {
  it('reports the version in package.json', () => {
    expect(SDK_VERSION).toBe(pkg.version)
  })

  it('reports this package by its published name, not @avsbhq/browser', () => {
    expect(SDK_TYPE).toBe(pkg.name)
  })

  it('carries a plain semver the dashboard can compare', () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
  })
})
