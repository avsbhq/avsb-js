import type { FlagDatafile, Logger, ExposureEvent } from '@avsbhq/core'
import { createRecsClient } from './recs'
import type { DatafileRecipe } from './recs'

// --- Helpers ---

const RECIPE: DatafileRecipe = {
  recipe: 'similar-products',
  chain: [
    { slug: 'similar-products', version: 12 },
    { slug: 'bestsellers', version: 8 },
  ],
  excludeOutOfStock: true,
  sessionAffinity: false,
}

function makeDatafile(
  overrides: Partial<FlagDatafile & { recipes?: DatafileRecipe[] }> = {},
): FlagDatafile {
  return {
    version: 2,
    projectType: 'FEATURE_FLAG',
    sdkKey: 'test-sdk-key',
    environmentKey: 'test',
    publishedAt: '2026-07-12T00:00:00.000Z',
    collectEndpoint: 'https://in.example.com',
    flags: [],
    audiences: [],
    recipes: [RECIPE],
    ...overrides,
  } as FlagDatafile
}

function makeLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() { return this },
  }
}

function makeTracker(): { queue: ReturnType<typeof vi.fn>; events: ExposureEvent[] } {
  const events: ExposureEvent[] = []
  const queue = vi.fn((event: ExposureEvent) => { events.push(event) })
  return { queue, events }
}

interface ClientSetup {
  datafile?: FlagDatafile | null
  tracker?: { queue: (event: ExposureEvent) => void } | null
}

function makeClient(setup: ClientSetup = {}) {
  return createRecsClient({
    sdkKey: 'test-sdk-key',
    getDatafile: () => (setup.datafile === undefined ? makeDatafile() : setup.datafile),
    getTracker: () => (setup.tracker === undefined ? null : setup.tracker),
    logger: makeLogger(),
  })
}

function mockFetchJson(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const mock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  global.fetch = mock
  return mock
}

const SERVED_RESPONSE = {
  data: {
    items: [
      { id: 'sku-1', title: 'Waffle throw', price: 4900, currency: 'USD', availability: 'in_stock' },
      { id: 'sku-2', title: 'Knit blanket' },
    ],
    served: { step: 0, slug: 'similar-products', version: 12 },
  },
}

const ATTRIBUTION = { visitorId: 'v-1', experimentId: 'exp-1', variationId: 'var-1' }

afterEach(() => {
  vi.restoreAllMocks()
})

// --- get() ---

describe('recs.get — resolve mapping', () => {
  it('POSTs the standard resolve body with the SDK key and returns RecProduct[]', async () => {
    const mock = mockFetchJson(SERVED_RESPONSE)

    const result = await makeClient().get({ recipe: 'similar-products', context: { seed: 'sku-9' } })

    expect(result.served).toBe(true)
    expect(result.recipe).toBe('similar-products')
    expect(result.source).toBe('similar-products')
    expect(result.fallbackStep).toBe(0)
    expect(result.degraded).toBe(false)
    expect(result.items).toEqual([
      { id: 'sku-1', title: 'Waffle throw', price: 4900, currency: 'USD', availability: 'in_stock' },
      { id: 'sku-2', title: 'Knit blanket' },
    ])

    expect(mock).toHaveBeenCalledTimes(1)
    const [url, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://in.example.com/v1/recs/resolve')
    expect(JSON.parse(init.body as string)).toEqual({
      snippetKey: 'test-sdk-key',
      seedKey: 'sku-9',
      assigned: 0,
      sources: [{ chain: RECIPE.chain }],
      maxItems: 8,
      excludeOutOfStock: true,
      merch: [],
      sessionAffinity: false,
    })
  })

  it('sends seedKeys for multi-seed context and _global when unseeded', async () => {
    const mock = mockFetchJson(SERVED_RESPONSE)
    const client = makeClient()

    await client.get({ recipe: 'similar-products', context: { seeds: ['sku-1', 'sku-2'] } })
    const multi = JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string)
    expect(multi.seedKeys).toEqual(['sku-1', 'sku-2'])
    expect(multi.seedKey).toBeUndefined()

    await client.get({ recipe: 'similar-products' })
    const unseeded = JSON.parse((mock.mock.calls[1][1] as RequestInit).body as string)
    expect(unseeded.seedKey).toBe('_global')
  })

  it('returns served:false for a recipe missing from the datafile registry, without fetching', async () => {
    const mock = mockFetchJson(SERVED_RESPONSE)

    const result = await makeClient().get({ recipe: 'unknown-recipe' })

    expect(result).toEqual({
      items: [],
      served: false,
      recipe: 'unknown-recipe',
      source: null,
      fallbackStep: null,
      degraded: false,
    })
    expect(mock).not.toHaveBeenCalled()
  })

  it('degrades to served:false before the datafile is ready — never throws', async () => {
    const result = await makeClient({ datafile: null }).get({ recipe: 'similar-products' })
    expect(result.served).toBe(false)
    expect(result.degraded).toBe(false)
  })

  it('degrades (served:false, degraded:true) on HTTP errors and network failures — never throws', async () => {
    mockFetchJson({ error: { code: 'internal', message: 'boom' } }, 500)
    const httpMiss = await makeClient().get({ recipe: 'similar-products' })
    expect(httpMiss).toMatchObject({ served: false, degraded: true, items: [] })

    global.fetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'))
    const networkMiss = await makeClient().get({ recipe: 'similar-products' })
    expect(networkMiss).toMatchObject({ served: false, degraded: true, items: [] })
  })
})

// --- Attribution ---

describe('recs.get — opt-in attribution', () => {
  it('fires no rec:impression when attribution is absent', async () => {
    mockFetchJson(SERVED_RESPONSE)
    const tracker = makeTracker()

    await makeClient({ tracker }).get({ recipe: 'similar-products' })

    expect(tracker.queue).not.toHaveBeenCalled()
  })

  it('queues exactly one rec:impression with the supplied ids when attribution is present', async () => {
    mockFetchJson(SERVED_RESPONSE)
    const tracker = makeTracker()

    await makeClient({ tracker }).get({
      recipe: 'similar-products',
      context: { seed: 'sku-9' },
      attribution: ATTRIBUTION,
    })

    expect(tracker.queue).toHaveBeenCalledTimes(1)
    const event = tracker.events[0]
    expect(event).toMatchObject({
      visitorId: 'v-1',
      experimentId: 'exp-1',
      variationId: 'var-1',
      eventName: 'rec:impression',
      revenue: null,
    })
    expect(event.attributes).toMatchObject({
      recipe: 'similar-products',
      seed: 'sku-9',
      slug: 'similar-products',
      step: '0',
      served: 'true',
      items: 'sku-1,sku-2',
    })
  })

  it('fires no impression on a miss branch (unknown recipe / HTTP failure)', async () => {
    const tracker = makeTracker()
    mockFetchJson({ error: { code: 'internal', message: 'x' } }, 500)

    await makeClient({ tracker }).get({ recipe: 'unknown-recipe', attribution: ATTRIBUTION })
    await makeClient({ tracker }).get({ recipe: 'similar-products', attribution: ATTRIBUTION })

    expect(tracker.queue).not.toHaveBeenCalled()
  })
})

// --- trackClick ---

describe('recs.trackClick', () => {
  it('queues a rec:click with ids, item, recipe and position', () => {
    const tracker = makeTracker()

    makeClient({ tracker }).trackClick('sku-2', {
      ...ATTRIBUTION,
      recipe: 'similar-products',
      position: 3,
    })

    expect(tracker.queue).toHaveBeenCalledTimes(1)
    expect(tracker.events[0]).toMatchObject({
      visitorId: 'v-1',
      experimentId: 'exp-1',
      variationId: 'var-1',
      eventName: 'rec:click',
    })
    expect(tracker.events[0].attributes).toEqual({
      recipe: 'similar-products',
      item: 'sku-2',
      position: '3',
    })
  })

  it('drops the click (no throw) when ids are missing or the tracker is not ready', () => {
    const tracker = makeTracker()

    // Missing ids → dropped.
    makeClient({ tracker }).trackClick('sku-2', {
      visitorId: '',
      experimentId: 'exp-1',
      variationId: 'var-1',
    })
    expect(tracker.queue).not.toHaveBeenCalled()

    // Tracker not ready → dropped, no throw.
    expect(() => makeClient({ tracker: null }).trackClick('sku-2', ATTRIBUTION)).not.toThrow()
  })
})
