import type { FlagDatafile, Logger } from '@avsbhq/core'
import { AvsbServer } from './AvsbServer'
import { createDatasetsClient } from './datasets'

// --- Helpers ---

function makeDatafile(overrides: Partial<FlagDatafile> = {}): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'test-sdk-key',
    environmentKey: 'test',
    publishedAt: '2026-06-12T00:00:00.000Z',
    collectEndpoint: 'https://in.example.com',
    flags: [],
    audiences: [],
    datasets: [
      { slug: 'vip-customers', type: 'LIST', liveVersion: 3 },
      { slug: 'product-catalog', type: 'TABLE', liveVersion: 12 },
    ],
    ...overrides,
  }
}

function makeLogger(): Logger & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    debug: [], info: [], warn: [], error: [],
  }
  return {
    calls,
    debug(...args: unknown[]) { calls.debug.push(args) },
    info(...args: unknown[]) { calls.info.push(args) },
    warn(...args: unknown[]) { calls.warn.push(args) },
    error(...args: unknown[]) { calls.error.push(args) },
    child() { return this },
  }
}

function makeClient(
  datafile: FlagDatafile | null,
  logger: Logger = makeLogger()
) {
  return createDatasetsClient({
    sdkKey: 'test-sdk-key',
    getDatafile: () => datafile,
    logger,
  })
}

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const mock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  )
  global.fetch = mock
  return mock
}

afterEach(() => {
  vi.restoreAllMocks()
})

// --- Found path ---

describe('datasets.get — found', () => {
  it('returns found=true with the parsed row and version meta for a TABLE hit', async () => {
    const row = { sku: 'SKU-1', price: 49.99 }
    mockFetchJson({ found: true, value: row })

    const result = await makeClient(makeDatafile()).get('product-catalog', 'SKU-1')

    expect(result).toEqual({
      found: true,
      value: row,
      meta: { slug: 'product-catalog', version: 12 },
    })
  })

  it('returns value=true for a LIST membership hit', async () => {
    mockFetchJson({ found: true, value: true })

    const result = await makeClient(makeDatafile()).get('vip-customers', 'user-77')

    expect(result.found).toBe(true)
    expect(result.value).toBe(true)
    expect(result.meta).toEqual({ slug: 'vip-customers', version: 3 })
  })

  it('fetches the worker endpoint with sdkKey, slug, live version and encoded key in the path', async () => {
    const mock = mockFetchJson({ found: true, value: true })

    await makeClient(makeDatafile()).get('vip-customers', 'user/7 7')

    expect(mock).toHaveBeenCalledTimes(1)
    const url = mock.mock.calls[0][0] as string
    expect(url).toBe(
      'https://in.example.com/v1/ds/test-sdk-key/vip-customers/3/user%2F7%207'
    )
  })

  it('strips trailing slashes from collectEndpoint when building the URL', async () => {
    const mock = mockFetchJson({ found: true, value: true })
    const datafile = makeDatafile({ collectEndpoint: 'https://in.example.com/' })

    await makeClient(datafile).get('vip-customers', 'user-1')

    expect(mock.mock.calls[0][0]).toBe(
      'https://in.example.com/v1/ds/test-sdk-key/vip-customers/3/user-1'
    )
  })
})

// --- Not-found path (worker says no) ---

describe('datasets.get — worker not-found', () => {
  it('returns found=false with the version meta when the worker reports found:false', async () => {
    mockFetchJson({ found: false })

    const result = await makeClient(makeDatafile()).get('product-catalog', 'missing-key')

    expect(result).toEqual({
      found: false,
      meta: { slug: 'product-catalog', version: 12 },
    })
  })

  it('treats a malformed worker body (no found field) as not found', async () => {
    mockFetchJson({ something: 'else' })

    const result = await makeClient(makeDatafile()).get('product-catalog', 'k')

    expect(result.found).toBe(false)
  })
})

// --- Unresolvable version path (no network call) ---

describe('datasets.get — unresolvable slug/version', () => {
  it('returns found=false with version null for an unknown slug without fetching', async () => {
    const mock = mockFetchJson({ found: true, value: true })

    const result = await makeClient(makeDatafile()).get('no-such-dataset', 'k')

    expect(result).toEqual({ found: false, meta: { slug: 'no-such-dataset', version: null } })
    expect(mock).not.toHaveBeenCalled()
  })

  it('returns found=false when the datafile has no datasets field at all', async () => {
    const mock = mockFetchJson({ found: true, value: true })
    const datafile = makeDatafile()
    delete datafile.datasets

    const result = await makeClient(datafile).get('vip-customers', 'k')

    expect(result).toEqual({ found: false, meta: { slug: 'vip-customers', version: null } })
    expect(mock).not.toHaveBeenCalled()
  })

  it('returns found=false when the dataset has no live version (liveVersion 0)', async () => {
    const mock = mockFetchJson({ found: true, value: true })
    const datafile = makeDatafile({
      datasets: [{ slug: 'vip-customers', type: 'LIST', liveVersion: 0 }],
    })

    const result = await makeClient(datafile).get('vip-customers', 'k')

    expect(result).toEqual({ found: false, meta: { slug: 'vip-customers', version: null } })
    expect(mock).not.toHaveBeenCalled()
  })

  it('returns found=false when the SDK has no datafile yet (not ready)', async () => {
    const mock = mockFetchJson({ found: true, value: true })

    const result = await makeClient(null).get('vip-customers', 'k')

    expect(result).toEqual({ found: false, meta: { slug: 'vip-customers', version: null } })
    expect(mock).not.toHaveBeenCalled()
  })

  it('returns found=false and warns for an empty slug or key', async () => {
    const logger = makeLogger()
    const client = makeClient(makeDatafile(), logger)

    expect(await client.get('', 'k')).toEqual({ found: false, meta: { slug: '', version: null } })
    expect(await client.get('vip-customers', '')).toEqual({
      found: false,
      meta: { slug: 'vip-customers', version: null },
    })
    expect(logger.calls.warn.length).toBe(2)
  })
})

// --- Failure path (never throws) ---

describe('datasets.get — network/HTTP failure degrades, never throws', () => {
  it('returns found=false on a non-OK HTTP status and logs a warning', async () => {
    mockFetchJson({ error: 'boom' }, 500)
    const logger = makeLogger()

    const result = await makeClient(makeDatafile(), logger).get('product-catalog', 'k')

    expect(result).toEqual({ found: false, meta: { slug: 'product-catalog', version: 12 } })
    expect(logger.calls.warn.length).toBe(1)
  })

  it('returns found=false when fetch rejects (network failure)', async () => {
    global.fetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'))
    const logger = makeLogger()

    const result = await makeClient(makeDatafile(), logger).get('vip-customers', 'k')

    expect(result).toEqual({ found: false, meta: { slug: 'vip-customers', version: 3 } })
    expect(logger.calls.warn.length).toBe(1)
  })

  it('returns found=false when the response body is not valid JSON', async () => {
    global.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('not json', { status: 200 })
    )

    const result = await makeClient(makeDatafile()).get('product-catalog', 'k')

    expect(result.found).toBe(false)
  })
})

// --- AvsbServer integration ---

describe('AvsbServer.datasets', () => {
  it('exposes a lazy datasets client that reads the bootstrap datafile', async () => {
    mockFetchJson({ found: true, value: { name: 'Widget' } })
    const server = new AvsbServer({
      sdkKey: 'test-sdk-key',
      bootstrap: makeDatafile(),
    })

    const result = await server.datasets.get('product-catalog', 'SKU-9')

    expect(result.found).toBe(true)
    expect(result.value).toEqual({ name: 'Widget' })
    expect(result.meta).toEqual({ slug: 'product-catalog', version: 12 })
    await server.close()
  })

  it('returns found=false before the server has a datafile', async () => {
    const mock = mockFetchJson({ found: true, value: true })
    const server = new AvsbServer({ sdkKey: 'test-sdk-key' })

    const result = await server.datasets.get('vip-customers', 'user-1')

    expect(result).toEqual({ found: false, meta: { slug: 'vip-customers', version: null } })
    expect(mock).not.toHaveBeenCalled()
    await server.close()
  })
})
