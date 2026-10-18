// Runtime-neutral SSE streaming client for A vs B SDK datafile updates.
//
// This module is the canonical home for SSE logic. `@avsbhq/node` re-exports
// `createStreamingClient` from here so existing AvsbServer import paths keep
// working. The `createBrowserStreamingClient` variant is consumed by
// `@avsbhq/browser`'s AvsbClient when `streaming: true`.
//
// Transport strategy:
//   - `createStreamingClient`         — fetch + ReadableStream (cross-runtime)
//   - `createBrowserStreamingClient`  — prefers native EventSource where
//     available; falls back to fetch+stream for older browsers / worker envs

import type { Logger } from '@avsbhq/core'

// The reconnect curve lives in ./backoff, the one shared implementation for
// the whole SDK family. It used to be inlined here as a "verbatim copy" of
// the node package's copy, alongside a third copy in the browser package.
import {
  nextBackoff,
  resetBackoff,
  parseRetryAfter,
  type BackoffState,
} from './backoff'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface StreamingClient {
  connect(): void
  disconnect(): void
  isConnected(): boolean
}

export interface StreamingOptions {
  /**
   * Ticket endpoint, resolved by the caller through
   * `resolveStreamEndpoint` from `@avsbhq/core` (explicit option, then the
   * datafile's `streamEndpoint` field, then nothing). Never guessed from
   * another host.
   *
   * The SDK fetches `${endpoint}?sdkKey=...` → { url, token, expiresInMs },
   * then opens SSE against `${url}?sdkKey=...&token=...`.
   */
  endpoint: string
  sdkKey: string
  onDatafileUpdated: () => void
  logger: Logger
  /**
   * Override for tests: collapses the exponential schedule to a fixed delay
   * so tests don't have to mock Math.random.
   */
  reconnectDelay?: number
}

interface TicketResponse {
  url: string
  token: string
  expiresInMs: number
}

// ---------------------------------------------------------------------------
// createStreamingClient — fetch + ReadableStream, works in every runtime
// ---------------------------------------------------------------------------

export function createStreamingClient(options: StreamingOptions): StreamingClient {
  const { endpoint, sdkKey, onDatafileUpdated, logger, reconnectDelay } = options

  let connected = false
  let connecting = false
  let disconnected = false
  let abortController: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoff: BackoffState | null = resetBackoff()
  let pendingRetryAfterMs: number | undefined = undefined

  function connect(): void {
    if (connected || connecting || disconnected) return
    connecting = true
    void startConnection()
  }

  function disconnect(): void {
    disconnected = true
    connected = false
    connecting = false
    if (abortController) {
      abortController.abort()
      abortController = null
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function isConnected(): boolean {
    return connected
  }

  async function fetchTicket(signal: AbortSignal): Promise<TicketResponse | null> {
    const ticketUrl = `${endpoint}?sdkKey=${encodeURIComponent(sdkKey)}`
    try {
      const res = await fetch(ticketUrl, { signal })
      if (!res.ok) {
        logger.warn('SSE ticket fetch failed', { status: res.status, url: ticketUrl })
        return null
      }
      const body = (await res.json()) as TicketResponse
      if (!body?.url || !body?.token) {
        logger.warn('SSE ticket response missing fields')
        return null
      }
      return body
    } catch (e) {
      if (signal.aborted) return null
      logger.warn('SSE ticket fetch error', { error: String(e) })
      return null
    }
  }

  async function startConnection(): Promise<void> {
    abortController = new AbortController()
    const signal = abortController.signal

    const ticket = await fetchTicket(signal)
    if (!ticket || signal.aborted) {
      if (!signal.aborted) scheduleReconnect()
      return
    }

    const streamUrl = `${ticket.url}?sdkKey=${encodeURIComponent(sdkKey)}&token=${encodeURIComponent(ticket.token)}`

    try {
      const response = await fetch(streamUrl, {
        headers: { Accept: 'text/event-stream' },
        signal,
      })

      if (response.status === 401) {
        logger.warn('SSE stream rejected token; refetching ticket')
        const next = await fetchTicket(signal)
        if (!next || signal.aborted) {
          if (!signal.aborted) scheduleReconnect()
          return
        }
        const retryUrl = `${next.url}?sdkKey=${encodeURIComponent(sdkKey)}&token=${encodeURIComponent(next.token)}`
        const retry = await fetch(retryUrl, {
          headers: { Accept: 'text/event-stream' },
          signal,
        })
        if (!retry.ok || !retry.body) {
          logger.warn('SSE retry failed', { status: retry.status })
          recordRetryAfter(retry.headers.get('retry-after'))
          scheduleReconnect()
          return
        }
        await pumpFrames(retry, signal)
        return
      }

      if (response.status === 429) {
        recordRetryAfter(response.headers.get('retry-after'))
        logger.warn('SSE rate-limited', { status: 429 })
        scheduleReconnect()
        return
      }

      if (!response.ok) {
        logger.warn('SSE connection failed', { status: response.status, url: streamUrl })
        recordRetryAfter(response.headers.get('retry-after'))
        scheduleReconnect()
        return
      }

      if (!response.body) {
        logger.warn('SSE response has no body')
        scheduleReconnect()
        return
      }

      await pumpFrames(response, signal)
    } catch (e) {
      if (signal.aborted) return
      logger.warn('SSE connection error', { error: String(e) })
      connected = false
      scheduleReconnect()
    }
  }

  function recordRetryAfter(headerValue: string | null): void {
    const parsed = parseRetryAfter(headerValue)
    if (parsed !== null) pendingRetryAfterMs = parsed
  }

  async function pumpFrames(response: Response, signal: AbortSignal): Promise<void> {
    connected = true
    connecting = false
    backoff = resetBackoff()
    pendingRetryAfterMs = undefined
    logger.info(`SSE connected to ${endpoint}`)

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim()
            if (!data) continue
            try {
              const parsed = JSON.parse(data) as { type?: string; publishedAt?: string }
              if (parsed.type === 'datafile_updated') {
                onDatafileUpdated()
              }
            } catch {
              logger.warn('Failed to parse SSE data', { data })
            }
          }
          // Ignore comment lines (: prefix) and empty lines
        }
      }
    } catch (e) {
      if (signal.aborted) return
      logger.warn('SSE stream read error', { error: String(e) })
    }

    connected = false
    scheduleReconnect()
  }

  function scheduleReconnect(): void {
    connecting = false
    if (disconnected || reconnectTimer) return
    if (typeof reconnectDelay === 'number') {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        if (disconnected) return
        connecting = true
        void startConnection()
      }, reconnectDelay)
      return
    }

    backoff = nextBackoff(backoff, pendingRetryAfterMs)
    pendingRetryAfterMs = undefined
    logger.warn(`SSE reconnect attempt ${backoff.attempt} in ${backoff.delayMs}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (disconnected) return
      connecting = true
      void startConnection()
    }, backoff.delayMs)
  }

  return { connect, disconnect, isConnected }
}

// ---------------------------------------------------------------------------
// createBrowserStreamingClient — EventSource-preferred, fetch fallback
//
// EventSource is simpler and handles HTTP/2 multiplexing well in modern
// browsers. We fall back to the fetch+ReadableStream path for:
//   - Environments without EventSource (some Cloudflare Workers, older mobile)
//   - Situations where custom headers (Authorization) are needed in future
// ---------------------------------------------------------------------------

export function createBrowserStreamingClient(options: StreamingOptions): StreamingClient {
  if (typeof EventSource !== 'undefined') {
    return createEventSourceClient(options)
  }
  return createStreamingClient(options)
}

// EventSource-backed implementation. Uses the same ticket fetch → EventSource
// URL pattern as the fetch path. EventSource handles reconnect natively but we
// layer our own disconnect/abort on top so `disconnect()` is instant.
function createEventSourceClient(options: StreamingOptions): StreamingClient {
  const { endpoint, sdkKey, onDatafileUpdated, logger, reconnectDelay } = options

  let connected = false
  let es: EventSource | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let backoff: BackoffState | null = resetBackoff()
  let aborted = false

  function connect(): void {
    if (connected || aborted) return
    void openSource()
  }

  function disconnect(): void {
    aborted = true
    connected = false
    es?.close()
    es = null
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function isConnected(): boolean {
    return connected
  }

  async function openSource(): Promise<void> {
    if (aborted) return

    // Fetch ticket — EventSource can't set request headers so we need the
    // URL-embedded token form.
    let ticketUrl: string
    try {
      const res = await fetch(`${endpoint}?sdkKey=${encodeURIComponent(sdkKey)}`)
      if (!res.ok) {
        logger.warn('SSE (EventSource) ticket fetch failed', { status: res.status })
        scheduleReconnect()
        return
      }
      const body = (await res.json()) as TicketResponse
      if (!body?.url || !body?.token) {
        logger.warn('SSE (EventSource) ticket response missing fields')
        scheduleReconnect()
        return
      }
      ticketUrl = `${body.url}?sdkKey=${encodeURIComponent(sdkKey)}&token=${encodeURIComponent(body.token)}`
    } catch (e) {
      if (aborted) return
      logger.warn('SSE (EventSource) ticket error', { error: String(e) })
      scheduleReconnect()
      return
    }

    if (aborted) return

    es = new EventSource(ticketUrl)

    es.addEventListener('open', () => {
      connected = true
      backoff = resetBackoff()
      logger.info(`SSE (EventSource) connected to ${endpoint}`)
    })

    es.addEventListener('message', (ev: MessageEvent) => {
      const data = typeof ev.data === 'string' ? ev.data.trim() : ''
      if (!data) return
      try {
        const parsed = JSON.parse(data) as { type?: string }
        if (parsed.type === 'datafile_updated') {
          onDatafileUpdated()
        }
      } catch {
        logger.warn('Failed to parse SSE (EventSource) data', { data })
      }
    })

    es.addEventListener('error', () => {
      if (aborted) return
      connected = false
      es?.close()
      es = null
      scheduleReconnect()
    })
  }

  function scheduleReconnect(): void {
    if (aborted || reconnectTimer) return
    if (typeof reconnectDelay === 'number') {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        void openSource()
      }, reconnectDelay)
      return
    }
    backoff = nextBackoff(backoff, undefined)
    logger.warn(`SSE (EventSource) reconnect attempt ${backoff.attempt} in ${backoff.delayMs}ms`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void openSource()
    }, backoff.delayMs)
  }

  return { connect, disconnect, isConnected }
}
