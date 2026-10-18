import { createStreamingClient } from './streaming'
import type { StreamingOptions } from './streaming'
import { noopLogger } from './logger'

// Two-step fetch dance: SDK first hits the Vercel `/api/sdk/stream` route
// to fetch a short-lived ticket {url, token, expiresInMs}, then opens SSE
// against `${url}?sdkKey=...&token=...`. These tests stub both legs via a
// router-style fetch mock keyed on the URL prefix.

const TICKET_ENDPOINT = 'https://app.avsb.app/api/sdk/stream'
const WORKER_SUBSCRIBE = 'https://stream.test/subscribe'
const FAKE_TOKEN = 'fake.token'
const TICKET_BODY = {
  url: WORKER_SUBSCRIBE,
  token: FAKE_TOKEN,
  expiresInMs: 60_000,
}

function createSSEStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index < events.length) {
        controller.enqueue(encoder.encode(events[index] + '\n'))
        index++
      } else {
        controller.close()
      }
    },
  })
}

function defaultOptions(overrides: Partial<StreamingOptions> = {}): StreamingOptions {
  return {
    endpoint: TICKET_ENDPOINT,
    sdkKey: 'test-sdk-key',
    onDatafileUpdated: vi.fn(),
    logger: noopLogger,
    reconnectDelay: 100,
    ...overrides,
  }
}

// Router-style mock: ticket fetch returns JSON, stream fetch returns SSE.
function mockFetchRouter(stream: ReadableStream<Uint8Array>): void {
  global.fetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    if (url.startsWith(TICKET_ENDPOINT)) {
      return new Response(JSON.stringify(TICKET_BODY), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })
}

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('createStreamingClient', () => {
  it('fetches a ticket from the Vercel endpoint with sdkKey', async () => {
    mockFetchRouter(createSSEStream([]))

    const client = createStreamingClient(defaultOptions())
    client.connect()

    await vi.waitFor(() => {
      const ticketCalls = vi
        .mocked(global.fetch)
        .mock.calls.filter((c) => String(c[0]).startsWith(TICKET_ENDPOINT))
      expect(ticketCalls.length).toBeGreaterThanOrEqual(1)
    })

    const firstCall = vi.mocked(global.fetch).mock.calls[0]
    expect(firstCall[0]).toBe(`${TICKET_ENDPOINT}?sdkKey=test-sdk-key`)

    client.disconnect()
  })

  it('opens SSE against the ticket URL with sdkKey + token in the query', async () => {
    mockFetchRouter(createSSEStream([]))

    const client = createStreamingClient(defaultOptions())
    client.connect()

    await vi.waitFor(() => {
      const subscribeCalls = vi
        .mocked(global.fetch)
        .mock.calls.filter((c) => String(c[0]).startsWith(WORKER_SUBSCRIBE))
      expect(subscribeCalls.length).toBeGreaterThanOrEqual(1)
    })

    const subscribeCall = vi
      .mocked(global.fetch)
      .mock.calls.find((c) => String(c[0]).startsWith(WORKER_SUBSCRIBE))!
    expect(String(subscribeCall[0])).toBe(
      `${WORKER_SUBSCRIBE}?sdkKey=test-sdk-key&token=${encodeURIComponent(FAKE_TOKEN)}`,
    )
    const init = subscribeCall[1] as RequestInit
    expect(init.headers).toEqual({ Accept: 'text/event-stream' })

    client.disconnect()
  })

  it('refetches the ticket once on a 401 from the stream', async () => {
    let streamCallCount = 0
    global.fetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.startsWith(TICKET_ENDPOINT)) {
        return new Response(JSON.stringify(TICKET_BODY), { status: 200 })
      }
      streamCallCount += 1
      if (streamCallCount === 1) {
        return new Response('expired', { status: 401 })
      }
      return new Response(createSSEStream([]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const client = createStreamingClient(defaultOptions())
    client.connect()

    await vi.waitFor(() => {
      expect(streamCallCount).toBeGreaterThanOrEqual(2)
    })

    const ticketCalls = vi
      .mocked(global.fetch)
      .mock.calls.filter((c) => String(c[0]).startsWith(TICKET_ENDPOINT))
    expect(ticketCalls.length).toBeGreaterThanOrEqual(2)

    client.disconnect()
  })

  it('parses datafile_updated event and calls onDatafileUpdated', async () => {
    mockFetchRouter(
      createSSEStream([
        'data: {"type":"datafile_updated","publishedAt":"2024-01-01T00:00:00Z"}',
      ]),
    )

    const onDatafileUpdated = vi.fn()
    const client = createStreamingClient(defaultOptions({ onDatafileUpdated }))
    client.connect()

    await vi.waitFor(() => {
      expect(onDatafileUpdated).toHaveBeenCalledTimes(1)
    })

    client.disconnect()
  })

  it('ignores non-datafile_updated event types', async () => {
    mockFetchRouter(
      createSSEStream([
        'data: {"type":"heartbeat"}',
        'data: {"type":"config_changed"}',
      ]),
    )

    const onDatafileUpdated = vi.fn()
    const client = createStreamingClient(defaultOptions({ onDatafileUpdated }))
    client.connect()

    await new Promise((r) => setTimeout(r, 50))
    expect(onDatafileUpdated).not.toHaveBeenCalled()

    client.disconnect()
  })

  it('ignores SSE comment lines (:keepalive)', async () => {
    mockFetchRouter(
      createSSEStream([
        ':keepalive',
        'data: {"type":"datafile_updated","publishedAt":"2024-01-01T00:00:00Z"}',
      ]),
    )

    const onDatafileUpdated = vi.fn()
    const client = createStreamingClient(defaultOptions({ onDatafileUpdated }))
    client.connect()

    await vi.waitFor(() => {
      expect(onDatafileUpdated).toHaveBeenCalledTimes(1)
    })

    client.disconnect()
  })

  it('schedules reconnect after stream ends', async () => {
    mockFetchRouter(
      createSSEStream([
        'data: {"type":"datafile_updated","publishedAt":"2024-01-01T00:00:00Z"}',
      ]),
    )

    const client = createStreamingClient(defaultOptions({ reconnectDelay: 100 }))
    client.connect()

    await vi.waitFor(
      () => {
        const ticketCalls = vi
          .mocked(global.fetch)
          .mock.calls.filter((c) => String(c[0]).startsWith(TICKET_ENDPOINT))
        // Reconnect re-fetches the ticket as well (single-use semantics).
        expect(ticketCalls.length).toBeGreaterThanOrEqual(2)
      },
      { timeout: 500 },
    )

    client.disconnect()
  })

  it('schedules reconnect when the ticket fetch fails', async () => {
    global.fetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValue(
        new Response(JSON.stringify(TICKET_BODY), { status: 200 }),
      )

    const client = createStreamingClient(defaultOptions({ reconnectDelay: 50 }))
    client.connect()

    await vi.waitFor(() => {
      expect(vi.mocked(global.fetch).mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    client.disconnect()
  })

  it('disconnect() cancels pending reconnect', async () => {
    vi.useFakeTimers()

    global.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 503 }),
    )

    const client = createStreamingClient(defaultOptions({ reconnectDelay: 5000 }))
    client.connect()

    await vi.advanceTimersByTimeAsync(0)
    expect(global.fetch).toHaveBeenCalledTimes(1)

    client.disconnect()
    await vi.advanceTimersByTimeAsync(10000)
    expect(global.fetch).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })
})
