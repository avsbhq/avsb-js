import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import {
  verifyWebhookSignature,
  DEFAULT_TOLERANCE_SECONDS,
  type WebhookHeaders,
} from './webhookSignature'

const SECRET = 'whsec_test_secret'
const DELIVERY_ID = 'del_abc123'
const TIMESTAMP = '2026-07-30T12:00:00.000Z'
const NOW = Date.parse(TIMESTAMP)

/** Sign exactly as the server does: HMAC over `id.timestamp.body`. */
function sign(deliveryId: string, timestamp: string, body: string, secret = SECRET): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${deliveryId}.${timestamp}.${body}`)
    .digest('hex')
}

function headersFor(body: string, overrides: Record<string, string> = {}): WebhookHeaders {
  return {
    'x-avsb-delivery-id': DELIVERY_ID,
    'x-avsb-timestamp': TIMESTAMP,
    'x-avsb-signature': `sha256=${sign(DELIVERY_ID, TIMESTAMP, body)}`,
    'x-avsb-event': 'experiment.launched',
    ...overrides,
  }
}

const BODY = JSON.stringify({ id: DELIVERY_ID, event: 'experiment.launched', test: true })

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed delivery and returns the delivery id', () => {
    const result = verifyWebhookSignature(BODY, headersFor(BODY), SECRET, { now: () => NOW })
    expect(result).toEqual({ ok: true, deliveryId: DELIVERY_ID, timestamp: TIMESTAMP })
  })

  it('accepts a Buffer payload identically to a string payload', () => {
    const result = verifyWebhookSignature(Buffer.from(BODY, 'utf8'), headersFor(BODY), SECRET, {
      now: () => NOW,
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a tampered body', () => {
    const tampered = JSON.stringify({ id: DELIVERY_ID, event: 'experiment.launched', test: false })
    const result = verifyWebhookSignature(tampered, headersFor(BODY), SECRET, { now: () => NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('signature_mismatch')
  })

  it('rejects a signature computed over the body alone (the pre-B18 scheme)', () => {
    // The exact regression the scheme change closes: a body-only HMAC replays
    // forever because nothing binds it to a delivery or a moment.
    const bodyOnly = crypto.createHmac('sha256', SECRET).update(BODY).digest('hex')
    const result = verifyWebhookSignature(
      BODY,
      headersFor(BODY, { 'x-avsb-signature': `sha256=${bodyOnly}` }),
      SECRET,
      { now: () => NOW },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('signature_mismatch')
  })

  it('rejects a replay whose timestamp is older than the tolerance', () => {
    const sixMinutesLater = NOW + (DEFAULT_TOLERANCE_SECONDS + 60) * 1000
    const result = verifyWebhookSignature(BODY, headersFor(BODY), SECRET, {
      now: () => sixMinutesLater,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('timestamp_out_of_tolerance')
    expect(result.message).toContain('tolerance')
  })

  it('rejects a timestamp far in the FUTURE too (clock skew both ways)', () => {
    const wayBefore = NOW - (DEFAULT_TOLERANCE_SECONDS + 60) * 1000
    const result = verifyWebhookSignature(BODY, headersFor(BODY), SECRET, { now: () => wayBefore })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('timestamp_out_of_tolerance')
  })

  it('accepts an old delivery when the age check is switched off', () => {
    const muchLater = NOW + 86_400_000
    const result = verifyWebhookSignature(BODY, headersFor(BODY), SECRET, {
      now: () => muchLater,
      toleranceSeconds: 0,
    })
    expect(result.ok).toBe(true)
  })

  it('rejects a signature made with a different secret', () => {
    const otherSecret = `sha256=${sign(DELIVERY_ID, TIMESTAMP, BODY, 'whsec_wrong')}`
    const result = verifyWebhookSignature(
      BODY,
      headersFor(BODY, { 'x-avsb-signature': otherSecret }),
      SECRET,
      { now: () => NOW },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('signature_mismatch')
  })

  it('rejects a delivery id that does not match the one that was signed', () => {
    const result = verifyWebhookSignature(
      BODY,
      headersFor(BODY, { 'x-avsb-delivery-id': 'del_someone_elses' }),
      SECRET,
      { now: () => NOW },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('signature_mismatch')
  })

  it('reports missing headers rather than failing the digest', () => {
    const result = verifyWebhookSignature(
      BODY,
      { 'x-avsb-timestamp': TIMESTAMP, 'x-avsb-signature': 'sha256=deadbeef' },
      SECRET,
      { now: () => NOW },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('missing_headers')
    expect(result.message).toContain('x-avsb-delivery-id')
  })

  it('reports a signature header without the sha256= prefix', () => {
    const result = verifyWebhookSignature(
      BODY,
      headersFor(BODY, { 'x-avsb-signature': sign(DELIVERY_ID, TIMESTAMP, BODY) }),
      SECRET,
      { now: () => NOW },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('malformed_signature')
  })

  it('reports a timestamp that is not an ISO instant', () => {
    const result = verifyWebhookSignature(
      BODY,
      headersFor(BODY, { 'x-avsb-timestamp': 'last tuesday' }),
      SECRET,
      { now: () => NOW },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('malformed_timestamp')
  })

  it('reads headers from a Headers-like object', () => {
    const headers = new Map<string, string>([
      ['x-avsb-delivery-id', DELIVERY_ID],
      ['x-avsb-timestamp', TIMESTAMP],
      ['x-avsb-signature', `sha256=${sign(DELIVERY_ID, TIMESTAMP, BODY)}`],
    ])
    const result = verifyWebhookSignature(
      BODY,
      { get: (name: string) => headers.get(name) ?? null },
      SECRET,
      { now: () => NOW },
    )
    expect(result.ok).toBe(true)
  })

  it('reads headers case-insensitively from a plain object', () => {
    const result = verifyWebhookSignature(
      BODY,
      {
        'X-AvsB-Delivery-Id': DELIVERY_ID,
        'X-AvsB-Timestamp': TIMESTAMP,
        'X-AvsB-Signature': `sha256=${sign(DELIVERY_ID, TIMESTAMP, BODY)}`,
      },
      SECRET,
      { now: () => NOW },
    )
    expect(result.ok).toBe(true)
  })

  it('rejects rather than throws when the digest lengths differ', () => {
    // timingSafeEqual throws on unequal lengths; the helper must not propagate that.
    const result = verifyWebhookSignature(
      BODY,
      headersFor(BODY, { 'x-avsb-signature': 'sha256=abc' }),
      SECRET,
      { now: () => NOW },
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('signature_mismatch')
  })
})
