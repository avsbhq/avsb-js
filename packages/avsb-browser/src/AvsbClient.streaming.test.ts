/**
 * §8.4 — Browser-side SSE streaming integration tests for AvsbClient.
 *
 * Verifies:
 *   - streaming: true wires up the streaming client after init
 *   - streaming: false (default) does not create a streaming client
 *   - configUpdate fires with reason 'stream' when the stream pushes
 *   - close() disconnects the streaming client
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { AvsbClient } from './AvsbClient'
import type { FlagDatafile } from './types'
import type { StreamingClient, StreamingOptions } from '@avsbhq/utils/streaming'
import * as streamingModule from '@avsbhq/utils/streaming'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_DATAFILE: FlagDatafile = {
  version: 1,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk_stream_test',
  environmentKey: 'production',
  publishedAt: '2025-01-01T00:00:00Z',
  collectEndpoint: 'http://localhost:3001/v1/collect/batch',
  flags: [],
  audiences: [],
}

const UPDATED_DATAFILE: FlagDatafile = {
  ...MINIMAL_DATAFILE,
  publishedAt: '2025-06-01T00:00:00Z',
}

// ---------------------------------------------------------------------------
// Streaming module mock
// ---------------------------------------------------------------------------

// We mock createBrowserStreamingClient so tests don't open real SSE
// connections. Each test can call the captured `onDatafileUpdated` callback
// to simulate a server-push event.
//
// `@avsbhq/utils/streaming` resolves to a built ESM dist file, and ESM module
// namespaces are not configurable — `vi.spyOn` on the namespace throws. So we
// replace the module with `vi.mock` + a hoisted mock function instead; the
// `streamingModule` namespace import above then resolves to this mock, which
// keeps the assertions below working unchanged.

interface MockStreamingClient {
  connect: () => void
  disconnect: () => void
  isConnected: () => boolean
}

const { createBrowserStreamingClientMock } = vi.hoisted(() => ({
  createBrowserStreamingClientMock:
    vi.fn<(options: StreamingOptions) => StreamingClient>(),
}))

vi.mock('@avsbhq/utils/streaming', () => ({
  createBrowserStreamingClient: createBrowserStreamingClientMock,
}))

let capturedOnDatafileUpdated: (() => void) | null = null
let mockStreamingClient: MockStreamingClient

beforeEach(() => {
  vi.unstubAllGlobals()
  // Datafiles are cached in localStorage, so start each test cold.
  localStorage.clear()
  capturedOnDatafileUpdated = null
  mockStreamingClient = {
    connect: vi.fn() as unknown as () => void,
    disconnect: vi.fn() as unknown as () => void,
    isConnected: vi.fn(() => false) as unknown as () => boolean,
  }
  // mockReset clears call history between tests — vi.restoreAllMocks only
  // touches vi.spyOn spies, not module-mock vi.fn instances.
  createBrowserStreamingClientMock.mockReset()
  createBrowserStreamingClientMock.mockImplementation((opts) => {
    capturedOnDatafileUpdated = opts.onDatafileUpdated
    return mockStreamingClient
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  capturedOnDatafileUpdated = null
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// vi.stubGlobal DEFINES the property instead of assigning to it, so it works
// whatever shape the environment gives `fetch` (data property, settable
// accessor, or getter-only accessor). vi.unstubAllGlobals() in the hooks
// restores the original descriptor.
function mockFetch(datafile: FlagDatafile = MINIMAL_DATAFILE): void {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(datafile), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AvsbClient — streaming: true', () => {
  it('wires up the streaming client after init completes', async () => {
    mockFetch()

    const client = new AvsbClient({
      sdkKey: 'sdk_stream_test',
      streaming: true,
      streamingEndpoint: 'https://app.avsb.cloud/api/sdk/stream',
      context: { kind: 'user', key: 'u1' },
    })

    await client.onReady()

    expect(streamingModule.createBrowserStreamingClient).toHaveBeenCalledTimes(1)
    expect(streamingModule.createBrowserStreamingClient).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://app.avsb.cloud/api/sdk/stream',
        sdkKey: 'sdk_stream_test',
      }),
    )
    expect(mockStreamingClient.connect).toHaveBeenCalledTimes(1)

    await client.close()
  })

  it('streaming: false (default) does not create a streaming client', async () => {
    mockFetch()

    const client = new AvsbClient({
      sdkKey: 'sdk_no_stream',
      context: { kind: 'user', key: 'u1' },
      // streaming not set → defaults to false
    })

    await client.onReady()

    expect(streamingModule.createBrowserStreamingClient).not.toHaveBeenCalled()

    await client.close()
  })

  it('configUpdate fires with reason "stream" when stream pushes datafile_updated', async () => {
    // First fetch: initial datafile. Second fetch (triggered by SSE): updated datafile.
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(MINIMAL_DATAFILE), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(UPDATED_DATAFILE), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const client = new AvsbClient({
      sdkKey: 'sdk_stream_test',
      streaming: true,
      streamingEndpoint: 'https://app.avsb.cloud/api/sdk/stream',
      context: { kind: 'user', key: 'u1' },
    })

    await client.onReady()

    const configUpdateHandler = vi.fn()
    client.on('configUpdate', configUpdateHandler)

    // Simulate the SSE server pushing a datafile_updated event.
    expect(capturedOnDatafileUpdated).not.toBeNull()
    await new Promise<void>((resolve) => {
      // Wrap in a micro-task so the async onStreamDatafileUpdated chain runs.
      capturedOnDatafileUpdated!()
      setTimeout(resolve, 50)
    })

    expect(configUpdateHandler).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'stream' }),
    )

    await client.close()
  })

  it('close() disconnects the streaming client', async () => {
    mockFetch()

    const client = new AvsbClient({
      sdkKey: 'sdk_stream_test',
      streaming: true,
      streamingEndpoint: 'https://app.avsb.cloud/api/sdk/stream',
      context: { kind: 'user', key: 'u1' },
    })

    await client.onReady()
    expect(mockStreamingClient.connect).toHaveBeenCalledTimes(1)

    await client.close()

    expect(mockStreamingClient.disconnect).toHaveBeenCalledTimes(1)
  })
})
