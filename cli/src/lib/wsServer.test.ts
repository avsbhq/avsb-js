import http from 'node:http'
import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { CliError } from './cliError.js'
import {
  DEFAULT_HOST,
  PORT_END,
  PORT_START,
  describeDevServer,
  devServerUrl,
  isLoopbackHost,
  isPortAnsweredOnLoopback,
  startDevServer,
  type DevServer,
} from './wsServer.js'

/**
 * Real sockets, on a block of ten high ports picked per run, so the test never
 * fights a developer's own `avsb dev` on 4400.
 */
const RANGE_SIZE = 10
let base = 0
const blockers: http.Server[] = []
const started: DevServer[] = []
const crashes: unknown[] = []
const onCrash = (err: unknown): void => {
  crashes.push(err)
}

function occupy(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer()
    server.once('error', reject)
    server.listen(port, () => {
      blockers.push(server)
      resolve()
    })
  })
}

async function start(count = RANGE_SIZE, host?: string): Promise<DevServer> {
  const server = await startDevServer({
    experimentName: 'Homepage headline',
    experimentId: 'exp_1',
    portRange: { start: base, end: base + count - 1 },
    host,
  })
  started.push(server)
  return server
}

beforeEach(() => {
  base = 40_000 + Math.floor(Math.random() * 2_000) * RANGE_SIZE
  crashes.length = 0
  process.on('uncaughtException', onCrash)
  process.on('unhandledRejection', onCrash)
})

afterEach(async () => {
  process.off('uncaughtException', onCrash)
  process.off('unhandledRejection', onCrash)
  await Promise.all(started.splice(0).map((server) => server.close()))
  await Promise.all(blockers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

describe('startDevServer port fallback (QA N4-6)', () => {
  it('takes the first port of the range when it is free, and answers /health', async () => {
    const server = await start()

    expect(server.port).toBe(base)
    const health = await fetch(`http://localhost:${server.port}/health`)
    expect(await health.text()).toBe('ok')
  })

  it('moves to the next port when the first one is busy', async () => {
    await occupy(base)

    const server = await start()

    expect(server.port).toBe(base + 1)
    expect(crashes).toEqual([])
  })

  it('lets a second dev server start beside the first', async () => {
    const first = await start()
    const second = await start()

    expect(second.port).toBe(first.port + 1)
  })

  it('ends in one clean error when every port is busy, with no unhandled exception', async () => {
    for (let port = base; port < base + RANGE_SIZE; port++) await occupy(port)

    const result = start().then(
      () => null,
      (err: unknown) => err,
    )
    const err = await result

    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).message).toBe(`Ports ${base} to ${base + RANGE_SIZE - 1} are all busy.`)
    expect((err as CliError).exitCode).toBe(1)
    // Give a stray `error` event a turn to surface before declaring none.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(crashes).toEqual([])
  })

  it('reports an error that is not a busy port instead of trying the rest of the range', async () => {
    await expect(
      startDevServer({ experimentName: 'x', experimentId: 'y', portRange: { start: 70_000, end: 70_001 } }),
    ).rejects.toThrow(RangeError)
  })

  it('defaults to the documented range, 4400 to 4409', () => {
    expect([PORT_START, PORT_END]).toEqual([4400, 4409])
  })
})

/** A non-loopback IPv4 address of this machine, or null on a machine with none. */
function lanAddress(): string | null {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return null
}

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_000) })
    return res.ok
  } catch {
    return false
  }
}

describe('startDevServer host (FU-37)', () => {
  it('listens on 127.0.0.1 by default, reachable as localhost, and not from the network', async () => {
    const server = await start()

    expect(DEFAULT_HOST).toBe('127.0.0.1')
    expect(server.host).toBe('127.0.0.1')
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`)
    expect(await reachable(`http://127.0.0.1:${server.port}/health`)).toBe(true)
    expect(await reachable(`http://localhost:${server.port}/health`)).toBe(true)
    const lan = lanAddress()
    // A machine with no network interface has nothing to be unreachable from.
    if (lan) expect(await reachable(`http://${lan}:${server.port}/health`)).toBe(false)
  })

  it('passes --host 0.0.0.0 through, listening on every interface', async () => {
    const server = await start(RANGE_SIZE, '0.0.0.0')

    expect(server.host).toBe('0.0.0.0')
    expect(server.url).toBe(`http://0.0.0.0:${server.port}`)
    expect(await reachable(`http://127.0.0.1:${server.port}/health`)).toBe(true)
    const lan = lanAddress()
    if (lan) expect(await reachable(`http://${lan}:${server.port}/health`)).toBe(true)
  })

  it('refuses a host that is not an address of this machine, in one plain sentence', async () => {
    // 203.0.113.0/24 is reserved for documentation, so no machine owns it.
    const err = await start(RANGE_SIZE, '203.0.113.7').then(
      () => null,
      (error: unknown) => error,
    )

    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).message).toBe('Cannot listen on 203.0.113.7: it is not an address of this machine.')
    expect(crashes).toEqual([])
  })

  it('skips a port another program holds on every interface, which a 127.0.0.1 bind alone would not notice on macOS', async () => {
    await occupy(base)

    expect(await isPortAnsweredOnLoopback(base)).toBe(true)
    expect(await isPortAnsweredOnLoopback(base + 1)).toBe(false)
    expect((await start()).port).toBe(base + 1)
  })
})

/**
 * Open a WebSocket the way a browser would, with the Origin it sends, and say
 * whether the server let it in (or the HTTP status it answered with).
 */
function handshake(port: number, origin?: string): Promise<'open' | number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, origin === undefined ? {} : { origin })
    socket.once('open', () => {
      socket.close()
      resolve('open')
    })
    socket.once('unexpected-response', (_req, res) => {
      socket.terminate()
      resolve(res.statusCode ?? 0)
    })
    socket.once('error', (err) => reject(err))
  })
}

describe('startDevServer WebSocket origins (2026-10-15 retest)', () => {
  it('refuses a web page from any other site with 403, before the upgrade', async () => {
    const server = await start()

    expect(await handshake(server.port, 'https://evil.example')).toBe(403)
    expect(await handshake(server.port, 'http://localhost.evil.example')).toBe(403)
    expect(server.getClientCount()).toBe(0)
  })

  it('lets the extension, a local page and a client with no Origin connect', async () => {
    const server = await start()

    expect(await handshake(server.port, 'chrome-extension://mpgaadhdlbondjlhpgfgffemogbchngm')).toBe('open')
    expect(await handshake(server.port, 'http://localhost:3000')).toBe('open')
    expect(await handshake(server.port)).toBe('open')
  })

  it('still answers /health to anyone, since it only says the server is up', async () => {
    const server = await start()

    const health = await fetch(`http://127.0.0.1:${server.port}/health`, {
      headers: { Origin: 'https://evil.example' },
    })
    expect(await health.text()).toBe('ok')
  })
})

describe('describeDevServer', () => {
  it('names the URL and says loopback is this machine only, with no warning', () => {
    expect(describeDevServer({ host: '127.0.0.1', url: 'http://127.0.0.1:4400' })).toEqual({
      line: 'Dev server running at http://127.0.0.1:4400 (this machine only)',
      warning: null,
    })
  })

  it('warns when the server is reachable from other devices', () => {
    expect(describeDevServer({ host: '0.0.0.0', url: 'http://0.0.0.0:4400' })).toEqual({
      line: 'Dev server running at http://0.0.0.0:4400',
      warning: 'Listening on 0.0.0.0: other devices on your network can reach this server and read the code it serves.',
    })
  })

  it('treats localhost, ::1 and the whole 127 block as loopback, and nothing else', () => {
    expect(['localhost', '::1', '127.0.0.1', '127.1.2.3'].every(isLoopbackHost)).toBe(true)
    expect(['0.0.0.0', '::', '192.168.1.20', '127.0.0.1.example.com'].some(isLoopbackHost)).toBe(false)
  })

  it('puts an IPv6 host in brackets in the URL', () => {
    expect(devServerUrl('::1', 4400)).toBe('http://[::1]:4400')
    expect(devServerUrl('127.0.0.1', 4400)).toBe('http://127.0.0.1:4400')
  })
})
