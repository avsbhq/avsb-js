// N1-6 (production QA 2026-10-01): `@avsbhq/node` kept the process alive for
// `initTimeout` (10 s by default) after `close()`, because the init race's
// timer was never cleared when the datafile won. Only a real child process
// can prove a process EXITS, so this spawns one (./closeExit.child.ts, run
// through tsx) against a local CDN and measures how long its event loop
// stays busy after `close()` returns.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHILD_SCRIPT = join(HERE, 'closeExit.child.ts')
const PACKAGE_DIR = join(HERE, '..')

/** The spec's bar: the process exits within 100 ms of close(). */
const MAX_LINGER_MS = 100
/** Far below the child's 30 s initTimeout, far above a tsx cold start. */
const CHILD_DEADLINE_MS = 15_000

interface ChildReport {
  success: boolean
  source: string
  lingerMs: number
}

let cdn: Server | null = null

afterEach(async () => {
  const server = cdn
  cdn = null
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** A local CDN: the datafile at /{key}/datafile.json, 200 for any POST. */
async function startCdn(datafileStatus: number): Promise<string> {
  let origin = ''
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/datafile.json')) {
      if (datafileStatus !== 200) {
        res.writeHead(datafileStatus, { 'content-type': 'text/plain' })
        res.end('Not Found')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', etag: '"close-exit"' })
      res.end(
        JSON.stringify({
          version: 2,
          projectType: 'FEATURE_FLAG',
          sdkKey: 'sdk_production_closeexitchild01',
          environmentKey: 'production',
          publishedAt: '2026-10-02T00:00:00.000Z',
          collectEndpoint: origin,
          heartbeatEndpoint: `${origin}/api/sdk/heartbeat`,
          flags: [],
          audiences: [],
        })
      )
      return
    }
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  cdn = server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return origin
}

function runChild(cdnHost: string): Promise<{ code: number | null; report: ChildReport }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD_SCRIPT, cdnHost], {
      cwd: PACKAGE_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const deadline = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new Error(
          `the child was still alive ${CHILD_DEADLINE_MS} ms after it started: ` +
            `something kept its event loop busy after close(). stderr: ${stderr}`
        )
      )
    }, CHILD_DEADLINE_MS)
    child.on('exit', (code) => {
      clearTimeout(deadline)
      const line = stdout.trim().split('\n').pop() ?? ''
      try {
        resolve({ code, report: JSON.parse(line) as ChildReport })
      } catch {
        reject(new Error(`the child printed no report. stdout: ${stdout} stderr: ${stderr}`))
      }
    })
  })
}

describe('AvsbServer close() lets the process exit (N1-6)', () => {
  it(`exits within ${MAX_LINGER_MS} ms of close() when the datafile wins the init race`, async () => {
    const { code, report } = await runChild(await startCdn(200))

    expect(report.success).toBe(true)
    expect(report.source).toBe('network')
    expect(report.lingerMs).toBeLessThan(MAX_LINGER_MS)
    expect(code).toBe(0)
  }, 30_000)

  it(`exits within ${MAX_LINGER_MS} ms of close() when init failed and polling had started`, async () => {
    const { code, report } = await runChild(await startCdn(404))

    expect(report.success).toBe(false)
    expect(report.source).toBe('error')
    expect(report.lingerMs).toBeLessThan(MAX_LINGER_MS)
    expect(code).toBe(0)
  }, 30_000)
})
