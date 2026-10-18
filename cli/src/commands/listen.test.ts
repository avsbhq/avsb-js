import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AvsbSession } from '../types/config.js'
import type { WebhookRelayTicket } from '../lib/webhookRelay.js'

const STREAM_URL = 'https://stream.test/webhooks/subscribe'
const FORWARD_URL = 'http://localhost:3000/webhooks/avsb'

const mocks = vi.hoisted(() => {
  return {
    ensureLoggedIn: vi.fn(),
    getWebhookRelayTicket: vi.fn(),
    logger: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      dim: vi.fn(),
      heading: vi.fn(),
      label: vi.fn(),
      field: vi.fn(),
      fileTree: vi.fn(),
      errorDetail: vi.fn(),
      line: vi.fn(),
    },
  }
})

vi.mock('../lib/logger.js', () => mocks.logger)
vi.mock('../lib/config.js', () => ({
  ensureLoggedIn: mocks.ensureLoggedIn,
  readConfig: vi.fn(),
  writeConfig: vi.fn(),
  getConfigPath: () => '/home/tester/.avsb/config.json',
}))
vi.mock('../lib/webhookApi.js', () => ({
  WebhookApiClient: class {
    getWebhookRelayTicket = mocks.getWebhookRelayTicket
  },
}))

class ProcessExitError extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

function session(): AvsbSession {
  return {
    token: 'pat_acme',
    orgId: 'org-1',
    orgName: 'Acme Corp',
    apiBaseUrl: 'https://app.avsb.cloud',
    tokenSource: 'config',
  }
}

function ticket(): WebhookRelayTicket {
  return { url: STREAM_URL, token: 'ticket-token', expiresInMs: 60_000, projectId: 'proj_1' }
}

const FRAME = {
  type: 'webhook_delivery',
  projectId: 'proj_1',
  deliveryId: 'del_1',
  event: 'experiment.launched',
  timestamp: '2026-07-30T12:34:56.000Z',
  signature: 'sha256=abc123',
  body: '{"id":"del_1","event":"experiment.launched"}',
  destinationId: 'dest_1',
  destinationUrl: 'https://example.com/hook',
}

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

interface FetchCall {
  url: string
  init: { headers?: Record<string, string>; body?: string; method?: string }
}

let fetchCalls: FetchCall[] = []

/**
 * Stub global fetch: the stream URL answers with a canned SSE body, anything else
 * is treated as the local forward target.
 */
function stubFetch(options: {
  stream?: { status: number; chunks?: string[] } | Error
  forward?: { status: number } | Error
}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: FetchCall['init'] = {}) => {
      fetchCalls.push({ url, init })

      if (url.startsWith(STREAM_URL)) {
        const stream = options.stream ?? { status: 200, chunks: [] }
        if (stream instanceof Error) throw stream
        return {
          ok: stream.status >= 200 && stream.status < 300,
          status: stream.status,
          body: stream.status === 200 ? sseBody(stream.chunks ?? []) : null,
        } as unknown as Response
      }

      const forward = options.forward ?? { status: 200 }
      if (forward instanceof Error) throw forward
      return {
        ok: forward.status >= 200 && forward.status < 300,
        status: forward.status,
      } as unknown as Response
    }),
  )
}

function streamCalls(): FetchCall[] {
  return fetchCalls.filter((call) => call.url.startsWith(STREAM_URL))
}

function forwardCalls(): FetchCall[] {
  return fetchCalls.filter((call) => call.url === FORWARD_URL)
}

/** Fresh command per run: commander keeps option values on the instance. */
async function runListen(argv: string[]): Promise<void> {
  vi.resetModules()
  const { listenCommand } = await import('./listen.js')
  await listenCommand.parseAsync(argv, { from: 'user' })
}

beforeEach(() => {
  fetchCalls = []
  vi.clearAllMocks()
  mocks.ensureLoggedIn.mockReturnValue(session())
  mocks.getWebhookRelayTicket.mockResolvedValue({ data: ticket() })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new ProcessExitError(typeof code === 'number' ? code : 0)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('streamRelayOnce', () => {
  async function stream(options: Parameters<typeof stubFetch>[0], forwardUrl: string | null = null) {
    stubFetch(options)
    const { streamRelayOnce } = await import('./listen.js')
    return streamRelayOnce({ ticket: ticket(), forwardUrl })
  }

  it('asks for an event stream with the ticket in the URL', async () => {
    await stream({ stream: { status: 200, chunks: [] } })

    expect(streamCalls()).toHaveLength(1)
    expect(streamCalls()[0].init.headers?.Accept).toBe('text/event-stream')
    expect(streamCalls()[0].url).toContain('token=ticket-token')
    expect(streamCalls()[0].url).toContain('projectId=proj_1')
  })

  it('counts and prints each delivery frame', async () => {
    const result = await stream({
      stream: {
        status: 200,
        chunks: [`data: ${JSON.stringify(FRAME)}\n\n`, `data: ${JSON.stringify(FRAME)}\n\n`],
      },
    })

    expect(result.outcome).toBe('ended')
    expect(result.connected).toBe(true)
    expect(result.received).toBe(2)
    const printed = mocks.logger.line.mock.calls.map((call) => String(call[0] ?? '')).join('\n')
    expect(printed).toContain('experiment.launched')
    expect(printed).toContain('del_1')
  })

  it('ignores keepalives, retry hints, and frames of another type', async () => {
    const result = await stream({
      stream: {
        status: 200,
        chunks: [
          'retry: 5000\n\n',
          ': keepalive\n\n',
          `data: ${JSON.stringify({ type: 'datafile_updated', publishedAt: 'x' })}\n\n`,
        ],
      },
    })

    expect(result.received).toBe(0)
    expect(result.outcome).toBe('ended')
  })

  it('reassembles a frame split across two chunks', async () => {
    const serialised = `data: ${JSON.stringify(FRAME)}\n\n`
    const result = await stream({
      stream: {
        status: 200,
        chunks: [serialised.slice(0, 25), serialised.slice(25)],
      },
    })

    expect(result.received).toBe(1)
  })

  it('forwards the delivery with the platform signature headers and raw body', async () => {
    const result = await stream(
      { stream: { status: 200, chunks: [`data: ${JSON.stringify(FRAME)}\n\n`] } },
      FORWARD_URL,
    )

    expect(result.forwarded).toBe(1)
    expect(forwardCalls()).toHaveLength(1)

    const forwarded = forwardCalls()[0]
    expect(forwarded.init.method).toBe('POST')
    expect(forwarded.init.headers?.['X-AvsB-Signature']).toBe(FRAME.signature)
    expect(forwarded.init.headers?.['X-AvsB-Timestamp']).toBe(FRAME.timestamp)
    expect(forwarded.init.headers?.['X-AvsB-Delivery-Id']).toBe(FRAME.deliveryId)
    expect(forwarded.init.headers?.['X-AvsB-Event']).toBe(FRAME.event)
    // Byte-identical body, or the signature would not verify locally.
    expect(forwarded.init.body).toBe(FRAME.body)
  })

  it('counts a rejected forward as a failure and keeps listening', async () => {
    const result = await stream(
      {
        stream: {
          status: 200,
          chunks: [`data: ${JSON.stringify(FRAME)}\n\n`, `data: ${JSON.stringify(FRAME)}\n\n`],
        },
        forward: { status: 500 },
      },
      FORWARD_URL,
    )

    expect(result.received).toBe(2)
    expect(result.forwarded).toBe(0)
    expect(result.forwardFailures).toBe(2)
    expect(result.outcome).toBe('ended')
  })

  it('survives a local server that is not running', async () => {
    const result = await stream(
      {
        stream: { status: 200, chunks: [`data: ${JSON.stringify(FRAME)}\n\n`] },
        forward: new Error('ECONNREFUSED'),
      },
      FORWARD_URL,
    )

    expect(result.received).toBe(1)
    expect(result.forwardFailures).toBe(1)
    expect(result.outcome).toBe('ended')
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'))
  })

  it('reports an unauthorized ticket separately from a transport failure', async () => {
    const result = await stream({ stream: { status: 401 } })

    expect(result.outcome).toBe('unauthorized')
    expect(result.connected).toBe(false)
  })

  it('explains a rate limit instead of printing a bare status', async () => {
    const result = await stream({ stream: { status: 429 } })

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('too many connection attempts')
  })

  it('reports a server error as a failure with its status', async () => {
    const result = await stream({ stream: { status: 503 } })

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('503')
  })

  it('reports an unreachable stream without pretending it connected', async () => {
    const result = await stream({ stream: new Error('getaddrinfo ENOTFOUND') })

    expect(result.outcome).toBe('failed')
    expect(result.connected).toBe(false)
    expect(result.error).toContain('ENOTFOUND')
  })
})

describe('avsb listen', () => {
  it('refuses an invalid --forward URL before touching the network', async () => {
    stubFetch({})

    await expect(runListen(['--project', '42', '--forward', 'localhost:3000'])).rejects.toThrow(
      ProcessExitError,
    )

    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('http://localhost:3000'))
    expect(mocks.getWebhookRelayTicket).not.toHaveBeenCalled()
    expect(fetchCalls).toHaveLength(0)
  })

  // QA N4-20: the docs promise exit 2 for a bad value; this exited 1.
  it('exits 2, the usage code, for a --forward that is not http or https', async () => {
    stubFetch({})

    const error = await runListen(['--project', '42', '--forward', 'ftp://x']).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ProcessExitError)
    expect((error as ProcessExitError).code).toBe(2)
    expect(mocks.logger.error).toHaveBeenCalledWith('"ftp://x" must start with http:// or https://.')
  })

  it('spells the dashboard location the way the dashboard does', async () => {
    stubFetch({ stream: { status: 401 } })

    await expect(runListen(['--project', '42', '--print-secret-hint'])).rejects.toThrow(ProcessExitError)

    const printed = mocks.logger.dim.mock.calls.map((call) => String(call[0])).join('\n')
    expect(printed).toContain('Organization Settings > Integrations > Webhooks')
  })

  it('exits 1 with an actionable message when the ticket cannot be minted', async () => {
    stubFetch({})
    mocks.getWebhookRelayTicket.mockRejectedValue(
      new Error('Webhook relay is not available on this platform deployment.'),
    )

    await expect(runListen(['--project', '42'])).rejects.toThrow(ProcessExitError)

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not start listening'),
    )
  })

  it('exits 1 without retrying when the stream rejects the ticket', async () => {
    stubFetch({ stream: { status: 401 } })

    await expect(runListen(['--project', '42'])).rejects.toThrow(ProcessExitError)

    expect(streamCalls()).toHaveLength(1)
    expect(mocks.logger.error).toHaveBeenCalledWith(expect.stringContaining('rejected'))
  })

  it('exits 1 when the first connection cannot be established', async () => {
    stubFetch({ stream: new Error('ECONNREFUSED') })

    await expect(runListen(['--project', '42'])).rejects.toThrow(ProcessExitError)

    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not connect to the relay'),
    )
  })

  it('prints the signing-secret hint only when asked', async () => {
    stubFetch({ stream: { status: 401 } })

    await expect(runListen(['--project', '42', '--print-secret-hint'])).rejects.toThrow(
      ProcessExitError,
    )

    expect(mocks.logger.heading).toHaveBeenCalledWith('Verifying signatures locally')
    // The secret itself is never printed: the platform cannot reveal it again.
    const printed = mocks.logger.dim.mock.calls.map((call) => String(call[0])).join('\n')
    expect(printed).toContain('rotated')
    expect(printed).not.toContain('whsec_')
  })
})

describe('sleep', () => {
  it('resolves immediately when the signal is already aborted', async () => {
    const { sleep } = await import('./listen.js')
    const controller = new AbortController()
    controller.abort()

    await expect(sleep(60_000, controller.signal)).resolves.toBeUndefined()
  })

  it('resolves as soon as the signal aborts', async () => {
    const { sleep } = await import('./listen.js')
    const controller = new AbortController()
    const waited = sleep(60_000, controller.signal)
    controller.abort()

    await expect(waited).resolves.toBeUndefined()
  })
})
