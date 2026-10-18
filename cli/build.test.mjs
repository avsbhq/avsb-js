/**
 * Build smoke test: the bundle npm ships has to start.
 *
 * 3.7.0 and 3.8.1 reached npm with a bundle that threw a SyntaxError before its
 * first line ran (a banner binding declared twice), while every unit test
 * passed: unit tests import the TypeScript sources, never the bundle. This file
 * builds the bundle exactly as `npm run build` and `prepublishOnly` do, then
 * runs it on the current Node the way an installed `avsb` runs.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const cliDir = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf-8'))

const BUILD_TIMEOUT_MS = 120_000
const RUN_TIMEOUT_MS = 30_000

/** A throwaway HOME, so no saved login or update cache on this machine is read. */
let home = ''
let buildResult = { status: null, stdout: '', stderr: '' }

/** The parent environment minus every AVSB_ setting, plus the isolation above. */
function childEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('AVSB_') && value !== undefined) env[key] = value
  }
  return { ...env, HOME: home, USERPROFILE: home, AVSB_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }
}

function run(command, args, cwd = home) {
  return spawnSync(command, args, { cwd, encoding: 'utf-8', env: childEnv(), timeout: RUN_TIMEOUT_MS })
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'avsb-cli-build-test-'))
  buildResult = spawnSync(process.execPath, [join(cliDir, 'build.mjs')], {
    cwd: cliDir,
    encoding: 'utf-8',
    env: childEnv(),
    timeout: BUILD_TIMEOUT_MS,
  })
}, BUILD_TIMEOUT_MS)

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true })
})

describe('the published CLI bundle', () => {
  it('builds, and the build itself refuses a bundle that cannot start', () => {
    expect(buildResult.stderr).toBe('')
    expect(buildResult.status).toBe(0)
    expect(buildResult.stdout).toContain(`(${pkg.version}, starts on Node ${process.versions.node})`)
  })

  it('prints the package version through the bin entry and exits 0', () => {
    const result = run(process.execPath, [join(cliDir, 'bin', 'avsb.js'), '--version'])

    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe(pkg.version)
    expect(result.status).toBe(0)
  })

  it('lists every top-level command in --help and exits 0', () => {
    const result = run(process.execPath, [join(cliDir, 'bin', 'avsb.js'), '--help'])

    expect(result.status).toBe(0)
    for (const command of ['init', 'login', 'push', 'dev', 'flags', 'metrics', 'metric-bindings', 'codegen', 'completion']) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+${command}\\b`, 'm'))
    }
  })

  it('exits 2 for an unknown command, so the error mapping survives bundling', () => {
    const result = run(process.execPath, [join(cliDir, 'bin', 'avsb.js'), 'no-such-command'])

    expect(result.status).toBe(2)
    expect(result.stderr).toContain("unknown command 'no-such-command'")
  })

  it('packs LICENSE, the bin entry, the bundle and both type files into the npm tarball', () => {
    const result = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], cliDir)

    expect(result.status).toBe(0)
    const [packed] = JSON.parse(result.stdout)
    const paths = packed.files.map((file) => file.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'LICENSE',
        'README.md',
        'package.json',
        'bin/avsb.js',
        'dist/cli.js',
        'dist/types/avsb.d.ts',
        'dist/types/variation-code.d.ts',
      ]),
    )
    expect(paths.some((path) => path.startsWith('src/'))).toBe(false)
  })
})
