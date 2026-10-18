// Webhook signature verification for AvsB outbound webhooks.
//
// Every delivery is signed with HMAC-SHA256 over `id + "." + timestamp + "." + body`
// (the Standard Webhooks scheme) using the webhook's signing secret, and carries
// three headers:
//
//   X-AvsB-Delivery-Id   the delivery id, also the `id` field in the body
//   X-AvsB-Timestamp     ISO-8601 instant the delivery was signed
//   X-AvsB-Signature     "sha256=<hex digest>"
//
// This module exists so the scheme lives in a library, not in every consumer's
// hand-rolled HMAC. Two things it gets right that hand-rolled checks routinely do
// not:
//
//   1. It verifies against the RAW BODY BYTES. `JSON.parse` then re-`stringify`
//      changes key order and whitespace, so a re-serialised body never matches the
//      digest. Read the raw body (Express: `express.raw({type: 'application/json'})`)
//      and pass that.
//   2. It rejects deliveries whose timestamp is outside a tolerance window (5
//      minutes by default). The timestamp is inside the signed content, so a captured
//      delivery cannot be replayed later — but only if you actually check the age,
//      which is what `toleranceSeconds` is for.
//
// Comparison is constant-time via `crypto.timingSafeEqual`, so the check does not
// leak how much of a forged signature was correct.

import crypto from 'crypto'

/** Default replay window: a delivery more than 5 minutes old is rejected. */
export const DEFAULT_TOLERANCE_SECONDS = 300

/** Header names AvsB sends, lowercased (HTTP headers are case-insensitive). */
const HEADER_ID = 'x-avsb-delivery-id'
const HEADER_TIMESTAMP = 'x-avsb-timestamp'
const HEADER_SIGNATURE = 'x-avsb-signature'

/**
 * Header bag shapes this accepts, so it works with Node's `IncomingHttpHeaders`,
 * a plain object, or a `Headers` instance (via `Object.fromEntries(headers)`).
 */
export type WebhookHeaders =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null }

export interface VerifyWebhookOptions {
  /**
   * How old a delivery may be, in seconds. Defaults to 300 (5 minutes). Set to 0 to
   * skip the age check entirely — only do that when you dedupe on the delivery id and
   * accept replays.
   */
  toleranceSeconds?: number
  /** Injectable clock, in ms since the epoch. Exists for tests. */
  now?: () => number
}

/** Why verification failed. `ok: false` always carries one of these. */
export type WebhookVerifyFailure =
  | 'missing_headers'
  | 'malformed_signature'
  | 'malformed_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch'

export type WebhookVerifyResult =
  | { ok: true; deliveryId: string; timestamp: string }
  | { ok: false; reason: WebhookVerifyFailure; message: string }

function readHeader(headers: WebhookHeaders, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(n: string): string | null }).get(name)
  }
  const bag = headers as Record<string, string | string[] | undefined>
  // A plain object may be keyed either way; Node lowercases, hand-built ones may not.
  const value = bag[name] ?? bag[name.toUpperCase()] ?? findCaseInsensitive(bag, name)
  if (value === undefined) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

function findCaseInsensitive(
  bag: Record<string, string | string[] | undefined>,
  name: string,
): string | string[] | undefined {
  for (const key of Object.keys(bag)) {
    if (key.toLowerCase() === name) return bag[key]
  }
  return undefined
}

/** Constant-time compare of two hex digests of equal length. */
function digestsMatch(a: string, b: string): boolean {
  // timingSafeEqual throws on a length mismatch, which would itself leak length, so
  // the lengths are compared first and a mismatch short-circuits.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * Verify one webhook delivery.
 *
 * @param payload The RAW request body, exactly as received (string or Buffer). Never
 *   a parsed-and-re-serialised object.
 * @param headers The request headers.
 * @param secret The webhook's signing secret, from the create or rotate response.
 *
 * @example
 * ```ts
 * import express from 'express'
 * import { verifyWebhookSignature } from '@avsbhq/node'
 *
 * app.post('/avsb-webhook', express.raw({ type: 'application/json' }), (req, res) => {
 *   const result = verifyWebhookSignature(req.body, req.headers, process.env.AVSB_WEBHOOK_SECRET!)
 *   if (!result.ok) return res.status(401).send(result.reason)
 *   const event = JSON.parse(req.body.toString('utf8'))
 *   // ... handle event, deduped on result.deliveryId
 *   res.sendStatus(200)
 * })
 * ```
 */
export function verifyWebhookSignature(
  payload: string | Buffer,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyWebhookOptions = {},
): WebhookVerifyResult {
  const deliveryId = readHeader(headers, HEADER_ID)
  const timestamp = readHeader(headers, HEADER_TIMESTAMP)
  const signatureHeader = readHeader(headers, HEADER_SIGNATURE)

  if (!deliveryId || !timestamp || !signatureHeader) {
    return {
      ok: false,
      reason: 'missing_headers',
      message: `Expected ${HEADER_ID}, ${HEADER_TIMESTAMP} and ${HEADER_SIGNATURE} headers. Got id=${Boolean(deliveryId)} timestamp=${Boolean(timestamp)} signature=${Boolean(signatureHeader)}.`,
    }
  }

  if (!signatureHeader.startsWith('sha256=')) {
    return {
      ok: false,
      reason: 'malformed_signature',
      message: `${HEADER_SIGNATURE} must look like "sha256=<hex>", got "${signatureHeader.slice(0, 16)}…".`,
    }
  }
  const provided = signatureHeader.slice('sha256='.length)

  const signedAtMs = Date.parse(timestamp)
  if (Number.isNaN(signedAtMs)) {
    return {
      ok: false,
      reason: 'malformed_timestamp',
      message: `${HEADER_TIMESTAMP} is not an ISO-8601 instant: "${timestamp}".`,
    }
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  if (tolerance > 0) {
    const nowMs = (options.now ?? Date.now)()
    const ageSeconds = Math.abs(nowMs - signedAtMs) / 1000
    if (ageSeconds > tolerance) {
      return {
        ok: false,
        reason: 'timestamp_out_of_tolerance',
        message: `Delivery signed ${Math.round(ageSeconds)}s from now, outside the ${tolerance}s tolerance. Check your server clock, or raise toleranceSeconds.`,
      }
    }
  }

  const body = typeof payload === 'string' ? payload : payload.toString('utf8')
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${deliveryId}.${timestamp}.${body}`)
    .digest('hex')

  if (!digestsMatch(provided, expected)) {
    return {
      ok: false,
      reason: 'signature_mismatch',
      message:
        'Signature does not match. Most common causes: the body was parsed and re-serialised before verification (use the raw bytes), or the secret is from a different webhook.',
    }
  }

  return { ok: true, deliveryId, timestamp }
}
