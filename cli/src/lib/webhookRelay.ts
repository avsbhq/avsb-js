/**
 * Wire shape and pure helpers for `avsb listen` (webhook relay) and
 * `avsb trigger`.
 *
 * The relay rides the platform's existing SSE plumbing: the CLI asks the
 * platform for a short-lived ticket, opens `text/event-stream` against the
 * stream worker, and reads one JSON frame per delivery. Everything in this file
 * is either the frame contract or a pure function, so the parsing, formatting,
 * forwarding headers, and retry schedule are all unit-testable without a socket.
 *
 * Frame contract mirror: `app/_lib/notifications/webhookRelay.ts` (publisher) and
 * `services/stream-worker/src/lib/webhookRelay.ts` (channel). Field names are
 * launch-final; treat them as an API.
 */

/** `type` discriminator on every relay frame. */
export const WEBHOOK_RELAY_FRAME_TYPE = 'webhook_delivery'

/** One relayed webhook delivery, exactly as the platform published it. */
export interface WebhookRelayFrame {
  type: typeof WEBHOOK_RELAY_FRAME_TYPE
  /** Project the delivery belongs to. */
  projectId: string
  /** Delivery id, matching the `X-AvsB-Delivery-Id` header and the body's `id`. */
  deliveryId: string
  /** Event name, e.g. `experiment.launched`. */
  event: string
  /** ISO-8601 instant the delivery was signed. */
  timestamp: string
  /** Full signature header value, including the `sha256=` prefix. */
  signature: string
  /** Raw body bytes as sent, as a string. Never re-serialise this. */
  body: string
  /** Which webhook destination received the real delivery. */
  destinationId: string
  /** That destination's URL. */
  destinationUrl: string
}

/** Ticket the platform hands out for one relay connection. */
export interface WebhookRelayTicket {
  url: string
  token: string
  expiresInMs: number
  projectId: string
}

export interface ApiWebhookRelayTicketResponse {
  data: WebhookRelayTicket
}

/** One triggerable event name plus its human label. */
export interface WebhookEventChoice {
  name: string
  label: string
}

export interface ApiWebhookEventListResponse {
  data: { events: WebhookEventChoice[] }
}

/** Outcome of one sample delivery, as `avsb trigger` prints it. */
export interface WebhookTriggerDelivery {
  webhookId: string
  webhookName: string
  url: string
  deliveryId: string
  status: string
  responseStatus: number | null
  error: string | null
}

export interface ApiWebhookTriggerResponse {
  data: { event: string; deliveries: WebhookTriggerDelivery[] }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Parse one SSE `data:` payload into a frame. Returns null for anything that is
 * not a complete delivery frame, so a future frame type on the same channel is
 * ignored rather than half-printed.
 */
export function parseRelayFrame(data: string): WebhookRelayFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Record<string, unknown>
  if (candidate.type !== WEBHOOK_RELAY_FRAME_TYPE) return null
  if (
    !isNonEmptyString(candidate.projectId) ||
    !isNonEmptyString(candidate.deliveryId) ||
    !isNonEmptyString(candidate.event) ||
    !isNonEmptyString(candidate.timestamp) ||
    !isNonEmptyString(candidate.signature) ||
    !isNonEmptyString(candidate.destinationId) ||
    !isNonEmptyString(candidate.destinationUrl) ||
    typeof candidate.body !== 'string'
  ) {
    return null
  }

  return {
    type: WEBHOOK_RELAY_FRAME_TYPE,
    projectId: candidate.projectId,
    deliveryId: candidate.deliveryId,
    event: candidate.event,
    timestamp: candidate.timestamp,
    signature: candidate.signature,
    body: candidate.body,
    destinationId: candidate.destinationId,
    destinationUrl: candidate.destinationUrl,
  }
}

/**
 * Headers for the forwarded copy. Deliberately identical to what the platform
 * sent, `User-Agent` included, so code that verifies a signature or reads a
 * header behaves the same locally as it will in production. The one addition is
 * `X-AvsB-Relayed-By`, so a local log can still tell the two apart.
 */
export function buildForwardHeaders(frame: WebhookRelayFrame): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'AvsB-Webhooks/1.0',
    'X-AvsB-Delivery-Id': frame.deliveryId,
    'X-AvsB-Event': frame.event,
    'X-AvsB-Signature': frame.signature,
    'X-AvsB-Timestamp': frame.timestamp,
    'X-AvsB-Relayed-By': 'avsb-cli',
  }
}

/**
 * `HH:MM:SS` in UTC, taken from the signed timestamp rather than the local
 * clock, so what is printed is what was signed. Unparseable input is returned
 * unchanged instead of being replaced with a wrong-looking time.
 */
export function formatRelayTime(timestamp: string): string {
  const parsed = Date.parse(timestamp)
  if (Number.isNaN(parsed)) return timestamp
  return new Date(parsed).toISOString().slice(11, 19)
}

/** Default body preview length on a delivery line. */
export const DEFAULT_BODY_PREVIEW_CHARS = 120

/** Shorten a body for one-line printing, saying how much was left out. */
export function previewBody(body: string, maxChars = DEFAULT_BODY_PREVIEW_CHARS): string {
  if (body.length <= maxChars) return body
  return `${body.slice(0, maxChars)}... (${body.length} chars total)`
}

/** The line printed for one received delivery. */
export function formatDeliveryLine(
  frame: WebhookRelayFrame,
  maxChars = DEFAULT_BODY_PREVIEW_CHARS,
): string {
  return `${formatRelayTime(frame.timestamp)} UTC  ${frame.event}  ${frame.deliveryId}  ${previewBody(frame.body, maxChars)}`
}

/** The line printed after a forward attempt. */
export function formatForwardLine(
  url: string,
  outcome: { status: number } | { error: string },
): string {
  if ('status' in outcome) return `  forwarded to ${url} (HTTP ${outcome.status})`
  return `  forward to ${url} failed: ${outcome.error}`
}

/** The line printed for one sample delivery sent by `avsb trigger`. */
export function formatTriggerDeliveryLine(delivery: WebhookTriggerDelivery): string {
  const status =
    delivery.responseStatus !== null ? `HTTP ${delivery.responseStatus}` : delivery.status
  const reason = delivery.error ? `  ${delivery.error}` : ''
  return `  ${delivery.webhookName}  ${delivery.url}  ${status}${reason}`
}

/**
 * Only http and https can carry a webhook, and a bare host is the most common
 * typo. Rejecting early beats a confusing fetch error on the first delivery.
 */
export function validateForwardUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return {
      ok: false,
      reason: `"${raw}" is not a URL. Use a full address, for example http://localhost:3000/webhooks/avsb`,
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // A bare `host:port` IS a valid URL (scheme `localhost:`), so this is where
    // "localhost:3000" lands rather than in the parse failure above. When the
    // input carries no scheme separator of its own, the corrected form is
    // obvious and worth printing: naming the rule without it leaves the reader
    // to guess. A real wrong scheme (ftp://...) gets the rule alone.
    const fix = raw.includes('//') ? '' : ` Try "http://${raw}".`
    return { ok: false, reason: `"${raw}" must start with http:// or https://.${fix}` }
  }
  return { ok: true, url: parsed.toString() }
}

/** How many reconnects in a row are attempted before the command gives up. */
export const MAX_RELAY_RECONNECT_ATTEMPTS = 10

const RELAY_BACKOFF_BASE_MS = 1_000
const RELAY_BACKOFF_CAP_MS = 30_000

/**
 * Capped exponential backoff: 1s, 2s, 4s, 8s, 16s, then 30s for every further
 * attempt. No jitter on purpose. Jitter exists to stop thousands of SDKs
 * reconnecting in lockstep, and this is one interactive process; a fixed
 * schedule is easier to explain in the docs and exactly testable.
 */
export function nextRelayBackoffMs(consecutiveFailures: number): number {
  const attempt = Math.max(1, consecutiveFailures)
  const raw = RELAY_BACKOFF_BASE_MS * 2 ** (attempt - 1)
  return Math.min(RELAY_BACKOFF_CAP_MS, raw)
}

/** Build the SSE URL for one connection from a ticket. */
export function buildRelayStreamUrl(ticket: WebhookRelayTicket): string {
  const query = new URLSearchParams({
    projectId: ticket.projectId,
    token: ticket.token,
  })
  return `${ticket.url}?${query.toString()}`
}

/**
 * Split an SSE buffer into complete lines, returning the trailing partial line
 * so the caller can carry it into the next chunk.
 */
export function splitSseLines(buffer: string): { lines: string[]; rest: string } {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  return { lines, rest }
}

/** The `data:` payload of an SSE line, or null for comments, blanks, and fields. */
export function readSseData(line: string): string | null {
  if (!line.startsWith('data:')) return null
  const data = line.slice('data:'.length).trim()
  return data.length > 0 ? data : null
}
