/**
 * The local server `avsb dev` and `avsb project dev` run for the browser
 * extension: plain HTTP for `/health`, a WebSocket for live updates.
 *
 * It takes the first free port from 4400 to 4409, so a second `avsb dev` in
 * another folder (or a leftover process on 4400) is not a problem. That used
 * to crash instead (QA N4-6): `WebSocketServer({ server })` re-emits the HTTP
 * server's `listen` error as its own `error` event, nothing listened for it,
 * and Node turned it into an unhandled exception before the loop below could
 * move on. Both servers now carry an error handler from the start, a busy port
 * closes both and tries the next one, and a full range ends in a plain
 * sentence and exit code 1.
 *
 * It listens on 127.0.0.1, this machine only, unless `--host` says otherwise.
 * It used to listen on every interface, so anyone on the same network (a cafe,
 * an office) could read the experiment code it serves and send it messages.
 *
 * A WebSocket is accepted only from the browser extension, a page served from
 * this machine, or a client that is not a browser (devOrigin.ts). Any other web
 * page open in the same browser is refused with 403 before the upgrade.
 */

import { WebSocketServer, WebSocket } from 'ws'
import http from 'node:http'
import net from 'node:net'
import { CliError } from './cliError.js'
import { REFUSED_ORIGIN_STATUS, isAllowedDevOrigin } from './devOrigin.js'
import type { WsMessageFromCli, WsMessageFromExtension } from '../types/dev.js'

export const PORT_START = 4400
export const PORT_END = 4409
/** This machine only. The extension connects to `localhost`, which reaches it. */
export const DEFAULT_HOST = '127.0.0.1'
const PING_INTERVAL_MS = 30_000
/** A loopback connect is refused at once when nothing listens; this only bounds a hung one. */
const PROBE_TIMEOUT_MS = 300
/** Both loopback addresses `localhost` can resolve to; the extension may use either. */
const LOOPBACK_PROBES = ['127.0.0.1', '::1'] as const

interface DevServerOptions {
  experimentName: string
  experimentId: string
  onExtensionMessage?: (msg: WsMessageFromExtension, ws: WebSocket) => void
  /** The ports to try, inclusive. Defaults to 4400 to 4409; tests pass their own. */
  portRange?: { start: number; end: number }
  /** The address to listen on. Defaults to 127.0.0.1 (this machine only). */
  host?: string
}

export interface DevServer {
  port: number
  /** The address it listens on. */
  host: string
  /** `http://<host>:<port>`, with an IPv6 host in brackets. */
  url: string
  broadcast: (msg: WsMessageFromCli) => void
  getClientCount: () => number
  close: () => Promise<void>
}

/** The error every port in the range gave back when all of them are taken. */
export function portsBusyError(start: number, end: number): CliError {
  return new CliError('cli_failed', `Ports ${start} to ${end} are all busy.`, [
    'Another `avsb dev` (or another program) is holding them. Stop it, then run this again.',
    `\`lsof -i :${start}\` shows what is listening on a port.`,
  ])
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined
}

function isAddressInUse(err: unknown): boolean {
  return errorCode(err) === 'EADDRINUSE'
}

/** Codes that mean the host itself is wrong, not the port: no such address or name here. */
const BAD_HOST_CODES = new Set(['EADDRNOTAVAIL', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME'])

/** The error for a `--host` this machine cannot listen on. */
export function badHostError(host: string): CliError {
  return new CliError('cli_failed', `Cannot listen on ${host}: it is not an address of this machine.`, [
    `Leave out --host to listen on ${DEFAULT_HOST} (this machine only), or pass 0.0.0.0 to listen on every interface.`,
  ])
}

/** True for an address only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * What `avsb dev` prints once the server is up: where it listens, and a warning
 * when that is reachable from other machines.
 */
export function describeDevServer(server: Pick<DevServer, 'host' | 'url'>): { line: string; warning: string | null } {
  if (isLoopbackHost(server.host)) {
    return { line: `Dev server running at ${server.url} (this machine only)`, warning: null }
  }
  return {
    line: `Dev server running at ${server.url}`,
    warning: `Listening on ${server.host}: other devices on your network can reach this server and read the code it serves.`,
  }
}

/** The URL to print for a host and port, with an IPv6 literal in brackets. */
export function devServerUrl(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`
}

function answersOn(address: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port })
    const done = (answered: boolean): void => {
      socket.destroy()
      resolve(answered)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * True when some program already answers on this port over loopback.
 *
 * Binding 127.0.0.1 is not enough to find out. On macOS a program listening on
 * every interface (an older `avsb dev`, another dev server) does not stop a
 * bind to 127.0.0.1 on the same port, so both would hold it, and the
 * extension's `localhost` connection could reach the other one. Asking the
 * port directly gives every operating system the same answer.
 */
export async function isPortAnsweredOnLoopback(port: number): Promise<boolean> {
  const answers = await Promise.all(LOOPBACK_PROBES.map((address) => answersOn(address, port)))
  return answers.some(Boolean)
}

export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const { experimentName, experimentId, onExtensionMessage } = options
  const start = options.portRange?.start ?? PORT_START
  const end = options.portRange?.end ?? PORT_END
  const host = options.host ?? DEFAULT_HOST

  let bound: { httpServer: http.Server; wss: WebSocketServer; port: number } | null = null
  for (let port = start; port <= end && !bound; port++) {
    if (await isPortAnsweredOnLoopback(port)) continue
    try {
      bound = { ...(await tryPort(port, host, experimentName, experimentId, onExtensionMessage)), port }
    } catch (err) {
      // A busy port is expected: try the next one. Anything else (a host that
      // is not this machine's, no permission, no network stack) would fail the
      // same way on every port, so it is reported as it is.
      if (BAD_HOST_CODES.has(String(errorCode(err)))) throw badHostError(host)
      if (!isAddressInUse(err)) throw err
    }
  }

  if (!bound) throw portsBusyError(start, end)
  const { httpServer, wss, port } = bound

  function broadcast(data: string): void {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data)
      }
    })
  }

  const pingInterval = setInterval(() => {
    const msg: WsMessageFromCli = { type: 'ping', timestamp: Date.now() }
    broadcast(JSON.stringify(msg))
  }, PING_INTERVAL_MS)

  return {
    port,
    host,
    url: devServerUrl(host, port),
    broadcast(msg: WsMessageFromCli) {
      broadcast(JSON.stringify(msg))
    },
    getClientCount() {
      let count = 0
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) count++
      })
      return count
    },
    async close() {
      clearInterval(pingInterval)
      const disconnectMsg: WsMessageFromCli = { type: 'dev:disconnect', reason: 'cli-stopped' }
      broadcast(JSON.stringify(disconnectMsg))

      // Force-close all WebSocket connections so the server doesn't hang
      wss.clients.forEach((client) => {
        client.terminate()
      })
      wss.close()

      // Destroy all remaining socket connections on the HTTP server
      httpServer.closeAllConnections()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    },
  }
}

function tryPort(
  port: number,
  host: string,
  experimentName: string,
  experimentId: string,
  onExtensionMessage?: (msg: WsMessageFromExtension, ws: WebSocket) => void
): Promise<{ httpServer: http.Server; wss: WebSocketServer }> {
  return new Promise((resolve, reject) => {
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
        return
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'running',
          experimentName,
          experimentId,
          port,
        })
      )
    })

    const wss = new WebSocketServer({
      server: httpServer,
      // A web page must not reach the code this server streams (devOrigin.ts).
      verifyClient: (info, done) => {
        if (isAllowedDevOrigin(info.req.headers.origin)) done(true)
        else done(false, REFUSED_ORIGIN_STATUS, 'Origin not allowed')
      },
    })

    let settled = false
    const fail = (err: unknown): void => {
      if (settled) return
      settled = true
      // Close both, so a busy port leaves nothing half-open behind it.
      wss.close()
      httpServer.close()
      reject(err)
    }

    // Both listeners exist before listen(): the WebSocket server re-emits the
    // HTTP server's errors, and an `error` event with no listener crashes.
    httpServer.on('error', fail)
    wss.on('error', fail)

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as WsMessageFromExtension
          onExtensionMessage?.(msg, ws)
        } catch {
          // Ignore malformed messages
        }
      })
    })

    httpServer.listen(port, host, () => {
      if (settled) return
      settled = true
      resolve({ httpServer, wss })
    })
  })
}
