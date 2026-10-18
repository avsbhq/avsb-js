import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BODY_PREVIEW_CHARS,
  MAX_RELAY_RECONNECT_ATTEMPTS,
  buildForwardHeaders,
  buildRelayStreamUrl,
  formatDeliveryLine,
  formatForwardLine,
  formatRelayTime,
  formatTriggerDeliveryLine,
  nextRelayBackoffMs,
  parseRelayFrame,
  previewBody,
  readSseData,
  splitSseLines,
  validateForwardUrl,
  type WebhookRelayFrame,
} from './webhookRelay.js'

const BODY = '{"id":"del_1","event":"experiment.launched"}'

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'webhook_delivery',
    projectId: 'proj_1',
    deliveryId: 'del_1',
    event: 'experiment.launched',
    timestamp: '2026-07-30T12:34:56.000Z',
    signature: 'sha256=abc123',
    body: BODY,
    destinationId: 'dest_1',
    destinationUrl: 'https://example.com/hook',
    ...overrides,
  }
}

function validFrame(): WebhookRelayFrame {
  const parsed = parseRelayFrame(JSON.stringify(frame()))
  if (!parsed) throw new Error('fixture frame must parse')
  return parsed
}

describe('parseRelayFrame', () => {
  it('parses a complete frame', () => {
    expect(parseRelayFrame(JSON.stringify(frame()))).toEqual(frame())
  })

  it('ignores a frame of another type on the same channel', () => {
    expect(parseRelayFrame(JSON.stringify({ type: 'datafile_updated', publishedAt: 'x' }))).toBeNull()
  })

  it('ignores malformed JSON instead of throwing mid-stream', () => {
    expect(parseRelayFrame('{"type":')).toBeNull()
    expect(parseRelayFrame('')).toBeNull()
  })

  it('ignores a frame missing the fields a forward needs', () => {
    expect(parseRelayFrame(JSON.stringify(frame({ signature: undefined })))).toBeNull()
    expect(parseRelayFrame(JSON.stringify(frame({ timestamp: '' })))).toBeNull()
    expect(parseRelayFrame(JSON.stringify(frame({ body: { id: 'del_1' } })))).toBeNull()
  })
})

describe('buildForwardHeaders', () => {
  it('reproduces the platform signature headers exactly', () => {
    const headers = buildForwardHeaders(validFrame())

    expect(headers['X-AvsB-Delivery-Id']).toBe('del_1')
    expect(headers['X-AvsB-Event']).toBe('experiment.launched')
    expect(headers['X-AvsB-Signature']).toBe('sha256=abc123')
    expect(headers['X-AvsB-Timestamp']).toBe('2026-07-30T12:34:56.000Z')
  })

  it('keeps the production content type and user agent so local code behaves the same', () => {
    const headers = buildForwardHeaders(validFrame())

    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['User-Agent']).toBe('AvsB-Webhooks/1.0')
  })

  it('marks the copy as relayed so a local log can tell it apart', () => {
    expect(buildForwardHeaders(validFrame())['X-AvsB-Relayed-By']).toBe('avsb-cli')
  })
})

describe('formatRelayTime', () => {
  it('shows the signed instant in UTC, not the local clock', () => {
    expect(formatRelayTime('2026-07-30T12:34:56.000Z')).toBe('12:34:56')
  })

  it('returns the raw value when it is not a timestamp', () => {
    expect(formatRelayTime('not-a-date')).toBe('not-a-date')
  })
})

describe('previewBody', () => {
  it('leaves a short body alone', () => {
    expect(previewBody(BODY)).toBe(BODY)
  })

  it('truncates a long body and says how long it really was', () => {
    const long = 'x'.repeat(DEFAULT_BODY_PREVIEW_CHARS + 50)
    const preview = previewBody(long)

    expect(preview.startsWith('x'.repeat(DEFAULT_BODY_PREVIEW_CHARS))).toBe(true)
    expect(preview).toContain(`${long.length} chars total`)
  })

  it('respects a custom limit', () => {
    expect(previewBody('abcdefgh', 4)).toContain('abcd')
  })
})

describe('formatDeliveryLine', () => {
  it('leads with the time, event, and delivery id', () => {
    const line = formatDeliveryLine(validFrame())

    expect(line).toContain('12:34:56 UTC')
    expect(line).toContain('experiment.launched')
    expect(line).toContain('del_1')
    expect(line).toContain(BODY)
  })
})

describe('formatForwardLine', () => {
  it('reports the status the local server returned', () => {
    expect(formatForwardLine('http://localhost:3000/hook', { status: 204 })).toContain('HTTP 204')
  })

  it('reports why a forward failed', () => {
    const line = formatForwardLine('http://localhost:3000/hook', { error: 'ECONNREFUSED' })

    expect(line).toContain('failed')
    expect(line).toContain('ECONNREFUSED')
  })
})

describe('formatTriggerDeliveryLine', () => {
  it('shows the response status when there is one', () => {
    const line = formatTriggerDeliveryLine({
      webhookId: 'hook-1',
      webhookName: 'Local dev',
      url: 'https://example.com/hook',
      deliveryId: 'del-1',
      status: 'DELIVERED',
      responseStatus: 200,
      error: null,
    })

    expect(line).toContain('Local dev')
    expect(line).toContain('HTTP 200')
  })

  it('falls back to the delivery status and shows the error when the POST never landed', () => {
    const line = formatTriggerDeliveryLine({
      webhookId: 'hook-1',
      webhookName: 'Local dev',
      url: 'https://example.com/hook',
      deliveryId: 'del-1',
      status: 'FAILED',
      responseStatus: null,
      error: 'Request timed out (10s)',
    })

    expect(line).toContain('FAILED')
    expect(line).toContain('Request timed out (10s)')
  })
})

describe('validateForwardUrl', () => {
  it('accepts a local http address', () => {
    expect(validateForwardUrl('http://localhost:3000/webhooks/avsb')).toEqual({
      ok: true,
      url: 'http://localhost:3000/webhooks/avsb',
    })
  })

  it('rejects a bare host with an example of what to type', () => {
    const result = validateForwardUrl('localhost:3000')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('http://localhost:3000')
  })

  it('rejects a non-http scheme', () => {
    const result = validateForwardUrl('ftp://example.com/hook')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('http://')
  })
})

describe('nextRelayBackoffMs', () => {
  it('doubles from one second and stops at thirty', () => {
    expect(nextRelayBackoffMs(1)).toBe(1_000)
    expect(nextRelayBackoffMs(2)).toBe(2_000)
    expect(nextRelayBackoffMs(3)).toBe(4_000)
    expect(nextRelayBackoffMs(5)).toBe(16_000)
    expect(nextRelayBackoffMs(6)).toBe(30_000)
    expect(nextRelayBackoffMs(50)).toBe(30_000)
  })

  it('treats a zero or negative count as the first attempt', () => {
    expect(nextRelayBackoffMs(0)).toBe(1_000)
    expect(nextRelayBackoffMs(-3)).toBe(1_000)
  })

  it('gives up long before the delay is meaningless', () => {
    expect(MAX_RELAY_RECONNECT_ATTEMPTS).toBeGreaterThan(1)
    expect(nextRelayBackoffMs(MAX_RELAY_RECONNECT_ATTEMPTS)).toBe(30_000)
  })
})

describe('buildRelayStreamUrl', () => {
  it('puts the project and ticket in the query string', () => {
    const url = buildRelayStreamUrl({
      url: 'https://stream.avsb.cloud/webhooks/subscribe',
      token: 'tok en/with+chars',
      expiresInMs: 60_000,
      projectId: 'proj_1',
    })

    expect(url.startsWith('https://stream.avsb.cloud/webhooks/subscribe?')).toBe(true)
    const query = new URL(url).searchParams
    expect(query.get('projectId')).toBe('proj_1')
    expect(query.get('token')).toBe('tok en/with+chars')
  })
})

describe('splitSseLines', () => {
  it('returns complete lines and keeps the partial tail', () => {
    expect(splitSseLines('a\nb\npart')).toEqual({ lines: ['a', 'b'], rest: 'part' })
  })

  it('keeps everything as the tail when no newline has arrived', () => {
    expect(splitSseLines('data: {"a"')).toEqual({ lines: [], rest: 'data: {"a"' })
  })
})

describe('readSseData', () => {
  it('reads a data line', () => {
    expect(readSseData('data: {"type":"webhook_delivery"}')).toBe('{"type":"webhook_delivery"}')
  })

  it('ignores keepalive comments, retry hints, and blank lines', () => {
    expect(readSseData(': keepalive')).toBeNull()
    expect(readSseData('retry: 5000')).toBeNull()
    expect(readSseData('')).toBeNull()
    expect(readSseData('data:')).toBeNull()
  })
})
