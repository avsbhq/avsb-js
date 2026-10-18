// Tests for the runtime-neutral SSE streaming client in @avsbhq/utils/streaming.
// Covers createStreamingClient (fetch+ReadableStream path) and the
// createBrowserStreamingClient EventSource fallback path.
//
// The EventSource path is exercised by deleting the global and letting
// createBrowserStreamingClient fall back to createStreamingClient.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createStreamingClient, createBrowserStreamingClient } from './streaming'
import type { StreamingOptions } from './streaming'
import { noopLogger } from '@avsbhq/core'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  let drainedDeferred: { promise: Promise<void>; resolve: () => void } | null = null
  return new ReadableStream({
    pull(controller) {
      if (index < events.length) {
        controller.enqueue(encoder.encode(events[index] + '\n'))
        index++
        return
      }
      // After all events have been pumped, keep the stream open so the
      // client's `connected` flag stays true and consumers can drive
      // disconnect themselves. Returning an unresolved promise parks
      // `reader.read()` until the controller is cancelled via abort.
      if (!drainedDeferred) {
        let resolveFn: () => void = () => {}
        const promise = new Promise<void>((r) => {
          resolveFn = r
        })
        drainedDeferred = { promise, resolve: resolveFn }
      }
      return drainedDeferred.promise
    },
    cancel() {
      drainedDeferred?.resolve()
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

/** Router-style fetch mock: ticket URL → JSON body, stream URL → SSE stream. */
function mockFetchRouter(stream: ReadableStream<Uint8Array>): void {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
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
  vi.stubGlobal('fetch', fetchMock)
}

// vi.stubGlobal DEFINES the property instead of assigning to it, so it works
// whatever shape the environment gives `fetch` (data property, settable
// accessor, or getter-only accessor). vi.unstubAllGlobals() restores the
// original descriptor, so no manual save/restore is needed.
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// createStreamingClient — fetch+ReadableStream path
// ---------------------------------------------------------------------------

describe('createStreamingClient', () => {
  it('connects: receives a datafile_updated frame and calls onDatafileUpdated', async () => {
    mockFetchRouter(
      createSSEStream([
        'data: {"type":"datafile_updated","publishedAt":"2025-01-01T00:00:00Z"}',
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

  it('connection error → schedules reconnect per backoff and retries', async () => {
    // First call fails (ticket endpoint 500), subsequent calls succeed with
    // an empty stream so reconnect is observable via fetch call count.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValue(
        new Response(JSON.stringify(TICKET_BODY), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const client = createStreamingClient(defaultOptions({ reconnectDelay: 50 }))
    client.connect()

    await vi.waitFor(() => {
      expect(vi.mocked(global.fetch).mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    client.disconnect()
  })

  it('401 response → refetches ticket and retries the stream', async () => {
    let streamCallCount = 0
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
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
    vi.stubGlobal('fetch', fetchMock)

    const client = createStreamingClient(defaultOptions())
    client.connect()

    await vi.waitFor(() => {
      expect(streamCallCount).toBeGreaterThanOrEqual(2)
    })

    // Two ticket fetches: initial + post-401 refetch
    const ticketCalls = vi
      .mocked(global.fetch)
      .mock.calls.filter((c) => String(c[0]).startsWith(TICKET_ENDPOINT))
    expect(ticketCalls.length).toBeGreaterThanOrEqual(2)

    client.disconnect()
  })

  it('429 with Retry-After header → passes the delay to the reconnect schedule', async () => {
    vi.useFakeTimers()

    let callCount = 0
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.startsWith(TICKET_ENDPOINT)) {
        return new Response(JSON.stringify(TICKET_BODY), { status: 200 })
      }
      callCount++
      if (callCount === 1) {
        return new Response(null, {
          status: 429,
          headers: { 'retry-after': '3' }, // 3 seconds
        })
      }
      return new Response(createSSEStream([]), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = createStreamingClient(defaultOptions({ reconnectDelay: undefined }))
    client.connect()

    // Let the first fetch (ticket + 429 stream response) complete.
    await vi.advanceTimersByTimeAsync(10)
    expect(callCount).toBe(1)

    // Advance less than 3 s — no reconnect yet.
    await vi.advanceTimersByTimeAsync(2000)
    expect(callCount).toBe(1)

    // Advance past the Retry-After; reconnect should have fired.
    await vi.advanceTimersByTimeAsync(1500)
    expect(callCount).toBeGreaterThanOrEqual(2)

    client.disconnect()
    vi.useRealTimers()
  })

  it('disconnect() aborts an in-flight fetch and cancels pending reconnect', async () => {
    vi.useFakeTimers()

    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    )

    const client = createStreamingClient(defaultOptions({ reconnectDelay: 5000 }))
    client.connect()

    // Let the first fetch settle.
    await vi.advanceTimersByTimeAsync(0)
    expect(global.fetch).toHaveBeenCalledTimes(1)

    client.disconnect()

    // Advance well past the reconnect delay — no second fetch.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(global.fetch).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// createBrowserStreamingClient — when EventSource is absent, falls back to
// the fetch+stream path (same behaviour as createStreamingClient above).
// ---------------------------------------------------------------------------

describe('createBrowserStreamingClient (fetch fallback — no EventSource)', () => {
  it('falls back to fetch when EventSource is undefined and receives datafile_updated', async () => {
    // Ensure EventSource is not defined in this environment.
    expect(typeof EventSource).toBe('undefined')

    mockFetchRouter(
      createSSEStream([
        'data: {"type":"datafile_updated","publishedAt":"2025-01-01T00:00:00Z"}',
      ]),
    )

    const onDatafileUpdated = vi.fn()
    const client = createBrowserStreamingClient(defaultOptions({ onDatafileUpdated }))
    client.connect()

    await vi.waitFor(() => {
      expect(onDatafileUpdated).toHaveBeenCalledTimes(1)
    })

    client.disconnect()
  })

  it('isConnected() returns false before connect and true after stream open', async () => {
    mockFetchRouter(createSSEStream([]))

    const client = createBrowserStreamingClient(defaultOptions())
    expect(client.isConnected()).toBe(false)

    client.connect()

    await vi.waitFor(() => {
      expect(client.isConnected()).toBe(true)
    })

    client.disconnect()
    expect(client.isConnected()).toBe(false)
  })

  it('calling connect() twice does not open a second connection', async () => {
    mockFetchRouter(createSSEStream([]))

    const client = createBrowserStreamingClient(defaultOptions())
    client.connect()
    client.connect() // second call should be a no-op

    await vi.waitFor(() => {
      // Only one ticket fetch should have happened.
      const ticketCalls = vi
        .mocked(global.fetch)
        .mock.calls.filter((c) => String(c[0]).startsWith(TICKET_ENDPOINT))
      expect(ticketCalls.length).toBe(1)
    })

    client.disconnect()
  })
})
