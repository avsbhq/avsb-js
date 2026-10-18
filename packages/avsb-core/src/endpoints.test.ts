import { describe, it, expect } from 'vitest'
import {
  COLLECT_PATHS,
  DEFAULT_APP_HOST,
  DEFAULT_CDN_HOST,
  DEFAULT_COLLECT_HOST,
  collectOriginFrom,
  collectUrl,
  datafileObjectKey,
  datafileUrl,
  heartbeatUrl,
  previewObjectKey,
  previewUrl,
  resolveHeartbeatEndpoint,
  resolveStreamEndpoint,
  streamEndpointUrl,
  streamSubscribeUrl,
  streamTicketUrl,
} from './endpoints'

// The literal strings asserted here are the same ones the language-neutral
// `endpoints` conformance fixtures lock
// (packages/avsb-conformance/fixtures/endpoints/manifest.json). They are
// duplicated on purpose: the fixture is the cross-language contract, these
// assertions are the TypeScript side of it. If you change one, change both.

const SDK_KEY = 'sdk_production_abc123'

describe('datafileUrl', () => {
  it('builds {cdnHost}/{sdkKey}/datafile.json against the public CDN by default', () => {
    expect(datafileUrl(SDK_KEY)).toBe(
      'https://cdn.avsb.cloud/sdk_production_abc123/datafile.json',
    )
  })

  it('honours a custom CDN host and tolerates a trailing slash on it', () => {
    expect(datafileUrl(SDK_KEY, 'https://cdn.example.test')).toBe(
      'https://cdn.example.test/sdk_production_abc123/datafile.json',
    )
    expect(datafileUrl(SDK_KEY, 'https://cdn.example.test/')).toBe(
      'https://cdn.example.test/sdk_production_abc123/datafile.json',
    )
  })

  it('never emits the legacy /datafiles/ or /v1/datafiles/ shapes', () => {
    const url = datafileUrl(SDK_KEY)
    expect(url).not.toContain('/datafiles/')
    expect(url).not.toContain('/v1/')
    expect(url).not.toContain('datafile.avsb.cloud')
  })

  it('throws an actionable error instead of building a double-slash URL for an empty key', () => {
    expect(() => datafileUrl('')).toThrow(/without an SDK key/)
    expect(() => datafileUrl('   ')).toThrow(/Environments in the project sidebar/)
  })

  it('trims incidental whitespace around a pasted key', () => {
    expect(datafileUrl(` ${SDK_KEY} `)).toBe(datafileUrl(SDK_KEY))
  })
})

describe('previewUrl', () => {
  it('builds the per-environment preview snapshot URL', () => {
    expect(previewUrl(SDK_KEY)).toBe(
      'https://cdn.avsb.cloud/sdk_production_abc123/preview.json',
    )
  })

  it('differs from the datafile URL only in the filename', () => {
    expect(previewUrl(SDK_KEY).replace('preview.json', 'datafile.json')).toBe(
      datafileUrl(SDK_KEY),
    )
  })

  it('rejects an empty key the same way datafileUrl does', () => {
    expect(() => previewUrl('')).toThrow(TypeError)
  })
})

describe('object keys', () => {
  it('derives the R2 datafile key as <sdkKey>/datafile.json', () => {
    expect(datafileObjectKey(SDK_KEY)).toBe('sdk_production_abc123/datafile.json')
  })

  it('derives the R2 preview key as <sdkKey>/preview.json', () => {
    expect(previewObjectKey(SDK_KEY)).toBe('sdk_production_abc123/preview.json')
  })

  it('matches the tail of the public URL for the same key', () => {
    expect(datafileUrl(SDK_KEY).endsWith(datafileObjectKey(SDK_KEY))).toBe(true)
  })
})

describe('collectOriginFrom', () => {
  it('passes through a bare origin (flag datafile shape)', () => {
    expect(collectOriginFrom('https://ingest.avsb.cloud')).toBe(
      'https://ingest.avsb.cloud',
    )
  })

  it('strips a full collect path (web-experiment datafile shape)', () => {
    expect(collectOriginFrom('https://ingest.avsb.cloud/v1/collect/batch')).toBe(
      'https://ingest.avsb.cloud',
    )
    expect(collectOriginFrom('https://ingest.avsb.cloud/v1/collect/metric-batch')).toBe(
      'https://ingest.avsb.cloud',
    )
    expect(collectOriginFrom('https://ingest.avsb.cloud/v1/ping')).toBe(
      'https://ingest.avsb.cloud',
    )
  })

  it('strips trailing slashes', () => {
    expect(collectOriginFrom('https://ingest.example.test///')).toBe(
      'https://ingest.example.test',
    )
  })
})

describe('collectUrl', () => {
  it('appends every ingestion path to the default ingest host', () => {
    expect(collectUrl('single')).toBe('https://ingest.avsb.cloud/v1/collect')
    expect(collectUrl('batch')).toBe('https://ingest.avsb.cloud/v1/collect/batch')
    expect(collectUrl('metricBatch')).toBe(
      'https://ingest.avsb.cloud/v1/collect/metric-batch',
    )
    expect(collectUrl('orders')).toBe('https://ingest.avsb.cloud/v1/collect/orders')
    expect(collectUrl('errors')).toBe('https://ingest.avsb.cloud/v1/collect/errors')
    expect(collectUrl('ping')).toBe('https://ingest.avsb.cloud/v1/ping')
    expect(collectUrl('geo')).toBe('https://ingest.avsb.cloud/v1/geo')
  })

  it('never doubles the path when handed a datafile value that already carries one', () => {
    expect(collectUrl('batch', 'https://ingest.avsb.cloud/v1/collect/batch')).toBe(
      'https://ingest.avsb.cloud/v1/collect/batch',
    )
    expect(collectUrl('orders', 'https://ingest.avsb.cloud/v1/collect/batch')).toBe(
      'https://ingest.avsb.cloud/v1/collect/orders',
    )
  })

  it('routes to a self-hosted ingest origin when the datafile publishes one', () => {
    expect(collectUrl('batch', 'https://events.customer.test/')).toBe(
      'https://events.customer.test/v1/collect/batch',
    )
  })
})

describe('resolveStreamEndpoint', () => {
  it('prefers an explicit option over the datafile field', () => {
    const result = resolveStreamEndpoint({
      optionEndpoint: 'https://stream.example.test/ticket',
      datafileStreamEndpoint: 'https://app.avsb.cloud/api/sdk/stream',
    })
    expect(result).toEqual({
      available: true,
      endpoint: 'https://stream.example.test/ticket',
      source: 'option',
    })
  })

  it('falls back to the server-controlled datafile field', () => {
    const result = resolveStreamEndpoint({
      datafileStreamEndpoint: 'https://app.avsb.cloud/api/sdk/stream',
    })
    expect(result).toEqual({
      available: true,
      endpoint: 'https://app.avsb.cloud/api/sdk/stream',
      source: 'datafile',
    })
  })

  it('reports unavailable rather than guessing a host when both are absent', () => {
    const result = resolveStreamEndpoint({})
    expect(result.available).toBe(false)
    if (result.available) throw new Error('expected an unavailable resolution')
    expect(result.reason).toContain('streamEndpoint')
    expect(result.reason).toContain('Polling stays on')
    expect(result.reason).not.toContain('stream.avsb.cloud')
  })

  it('treats blank strings as absent', () => {
    expect(
      resolveStreamEndpoint({ optionEndpoint: '  ', datafileStreamEndpoint: '' }).available,
    ).toBe(false)
  })
})

describe('stream URL builders', () => {
  it('puts the sdk key on the ticket request as a query parameter', () => {
    expect(streamTicketUrl('https://app.avsb.cloud/api/sdk/stream', SDK_KEY)).toBe(
      'https://app.avsb.cloud/api/sdk/stream?sdkKey=sdk_production_abc123',
    )
  })

  it('builds the SSE URL from the url the ticket response handed back', () => {
    expect(
      streamSubscribeUrl('https://stream.example.test/subscribe', SDK_KEY, 'tkn_1'),
    ).toBe(
      'https://stream.example.test/subscribe?sdkKey=sdk_production_abc123&token=tkn_1',
    )
  })

  it('percent-encodes token characters that would otherwise break the query', () => {
    expect(
      streamSubscribeUrl('https://stream.example.test/subscribe', SDK_KEY, 'tk+n/1='),
    ).toBe(
      'https://stream.example.test/subscribe?sdkKey=sdk_production_abc123&token=tk%2Bn%2F1%3D',
    )
  })

  // Form encoding (Go url.QueryEscape, Java URLEncoder, Ruby CGI.escape) turns a
  // space into '+', which a query-string reader decodes back as a space only by
  // luck of the reader. Every port must emit %20 here, so the literal below is
  // the one the whole family is measured against.
  it('encodes a space in a token as %20 and a literal plus as %2B', () => {
    expect(
      streamSubscribeUrl('https://stream.example.test/subscribe', SDK_KEY, 'tk n+1'),
    ).toBe(
      'https://stream.example.test/subscribe?sdkKey=sdk_production_abc123&token=tk%20n%2B1',
    )
  })

  it('derives the fallback ticket URL from the app origin', () => {
    expect(streamEndpointUrl()).toBe('https://app.avsb.cloud/api/sdk/stream')
    expect(streamEndpointUrl('http://localhost:3000/')).toBe(
      'http://localhost:3000/api/sdk/stream',
    )
  })
})

describe('heartbeat', () => {
  it('derives the fallback heartbeat URL from the app origin', () => {
    expect(heartbeatUrl()).toBe('https://app.avsb.cloud/api/sdk/heartbeat')
    expect(heartbeatUrl('https://api.example.test')).toBe(
      'https://api.example.test/api/sdk/heartbeat',
    )
  })

  it('uses the datafile value verbatim when present', () => {
    expect(resolveHeartbeatEndpoint('https://api.example.test/api/sdk/heartbeat')).toBe(
      'https://api.example.test/api/sdk/heartbeat',
    )
  })

  it('returns null (do not send) when the datafile omits the endpoint', () => {
    expect(resolveHeartbeatEndpoint()).toBeNull()
    expect(resolveHeartbeatEndpoint(null)).toBeNull()
    expect(resolveHeartbeatEndpoint('   ')).toBeNull()
  })
})

describe('default hosts', () => {
  it('are the three real data-plane origins and nothing invented', () => {
    expect(DEFAULT_CDN_HOST).toBe('https://cdn.avsb.cloud')
    expect(DEFAULT_COLLECT_HOST).toBe('https://ingest.avsb.cloud')
    expect(DEFAULT_APP_HOST).toBe('https://app.avsb.cloud')
  })

  it('expose every collect path under /v1 with no trailing slash', () => {
    for (const path of Object.values(COLLECT_PATHS)) {
      expect(path.startsWith('/v1/')).toBe(true)
      expect(path.endsWith('/')).toBe(false)
    }
  })
})
