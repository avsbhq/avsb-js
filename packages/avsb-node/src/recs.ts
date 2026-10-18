import type { FlagDatafile, Logger } from '@avsbhq/core'
import type { ServerTracker } from './serverTracker'

/**
 * Server-side recommendations client (e-commerce suite overhaul, contract C3).
 *
 * Mirrors ./datasets.ts: resolves a recipe handle against the datafile's
 * recipe registry (`datafile.recipes`, additive) and POSTs the standard
 * resolve body to the edge worker:
 *
 *   POST {ingestionHost}/v1/recs/resolve
 *
 * The ingestion host is derived from the datafile's `collectEndpoint`. The
 * worker's key cache resolves SDK keys as well as snippet keys, so the body's
 * key field simply carries the SDK key.
 *
 * Attribution is OPT-IN server-side: `get()` fires a `rec:impression` (via
 * the server tracker) only when the caller passes `attribution`; a server
 * has no ambient variation context the way a browser harness does.
 *
 * Error posture matches datasets/flag evaluation: this client NEVER throws.
 * Unknown recipe, SDK not ready, HTTP errors, timeouts and network failures
 * all degrade to `{ items: [], served: false }`.
 */

export interface RecProduct {
  id: string
  title?: string
  image?: string
  href?: string
  category?: string
  /** MINOR units (ISO-4217). */
  price?: number
  /** MINOR units. */
  compareAtPrice?: number
  currency?: string
  availability?: 'in_stock' | 'out_of_stock' | 'removed'
}

export interface RecsAttribution {
  visitorId: string
  experimentId: string
  variationId: string
}

export interface RecsGetRequest {
  recipe: string
  context?: {
    /** Single seed product key (product page). */
    seed?: string
    /** Up to 3 seed product keys (cart page). */
    seeds?: string[]
  }
  maxItems?: number
  excludeOutOfStock?: boolean
  /** When present, a rec:impression is queued with these ids on success. */
  attribution?: RecsAttribution
}

export interface RecsResult {
  items: RecProduct[]
  served: boolean
  recipe: string
  /** Slug of the chain step that served, null on a miss. */
  source: string | null
  fallbackStep: number | null
  /** True when the resolve failed (timeout / network / HTTP / parse). */
  degraded: boolean
}

export interface RecsClient {
  /** Resolve items for a recipe. Never throws. */
  get(req: RecsGetRequest): Promise<RecsResult>
  /**
   * Queue a rec:click for a product the shopper clicked. Pass `recipe` when
   * known: results group click-through by (variation, recipe).
   */
  trackClick(
    productId: string,
    opts: RecsAttribution & { position?: number; recipe?: string },
  ): void
}

/**
 * One entry of the datafile recipe registry (contract C3). Additive on
 * FlagDatafile; SDKs on older datafiles see it absent.
 */
export interface DatafileRecipe {
  recipe: string
  chain: Array<{ slug: string; version: number }>
  excludeOutOfStock: boolean
  sessionAffinity: boolean
  merch?: unknown[]
}

export interface RecsClientOptions {
  sdkKey: string
  /** Live datafile accessor; reads the SDK's current datafile on every call. */
  getDatafile: () => FlagDatafile | null
  /** Live tracker accessor; null before init/after destroy (events dropped). */
  getTracker: () => Pick<ServerTracker, 'queue'> | null
  logger: Logger
  /** Per-request timeout in ms. Defaults to 10s (same as the tracker). */
  requestTimeout?: number
}

const DEFAULT_REQUEST_TIMEOUT = 10_000
const MAX_SEED_CHARS = 256
const MAX_SEEDS = 3
const MAX_ITEMS_CAP = 24
const DEFAULT_MAX_ITEMS = 8
const MAX_ID_CHARS = 64
const MAX_ATTR_VALUE_CHARS = 512
/** Row key list-algorithm recipes (bestsellers/trending) write to. */
const GLOBAL_SEED = '_global'

function clampMaxItems(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return DEFAULT_MAX_ITEMS
  return Math.min(Math.floor(value), MAX_ITEMS_CAP)
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** Comma-joins ids, dropping whole trailing ids past the attribute bound. */
function joinIds(ids: string[]): string {
  let out = ''
  for (const id of ids) {
    const next = out === '' ? id : `${out},${id}`
    if (next.length > MAX_ATTR_VALUE_CHARS) break
    out = next
  }
  return out
}

/** Defensive mapping of raw resolve items onto the public RecProduct shape. */
function toRecProducts(items: unknown[], cap: number): RecProduct[] {
  const out: RecProduct[] = []
  for (const item of items) {
    if (out.length >= cap) break
    if (item === null || typeof item !== 'object') continue
    const fields = item as Record<string, unknown>
    const id = (asText(fields.id) || asText(fields.sku)).slice(0, MAX_ID_CHARS)
    if (id === '') continue
    const product: RecProduct = { id }
    const title = asText(fields.title)
    if (title) product.title = title
    const image = asText(fields.image)
    if (image) product.image = image
    const href = asText(fields.href) || asText(fields.url)
    if (href && !/^\s*javascript:/i.test(href)) product.href = href
    const category = asText(fields.category)
    if (category) product.category = category
    if (typeof fields.price === 'number' && Number.isFinite(fields.price)) {
      product.price = Math.round(fields.price)
    }
    if (typeof fields.compareAtPrice === 'number' && Number.isFinite(fields.compareAtPrice)) {
      product.compareAtPrice = Math.round(fields.compareAtPrice)
    }
    if (typeof fields.currency === 'string' && fields.currency !== '') {
      product.currency = fields.currency
    }
    const availability = fields.availability
    if (availability === 'in_stock' || availability === 'out_of_stock' || availability === 'removed') {
      product.availability = availability
    }
    out.push(product)
  }
  return out
}

function miss(recipe: string, degraded: boolean): RecsResult {
  return { items: [], served: false, recipe, source: null, fallbackStep: null, degraded }
}

interface ResolveWireData {
  items?: unknown[]
  served?: { step: number; slug: string; version: number } | null
}

export function createRecsClient(options: RecsClientOptions): RecsClient {
  const { sdkKey, getDatafile, getTracker, logger } = options
  const requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT

  function resolveSeeds(context: RecsGetRequest['context']): string[] {
    const clip = (s: string): string => s.slice(0, MAX_SEED_CHARS)
    if (Array.isArray(context?.seeds)) {
      const seeds = context.seeds
        .filter((s): s is string => typeof s === 'string' && s !== '')
        .slice(0, MAX_SEEDS)
        .map(clip)
      if (seeds.length > 0) return seeds
    }
    if (typeof context?.seed === 'string' && context.seed !== '') return [clip(context.seed)]
    return [GLOBAL_SEED]
  }

  async function get(req: RecsGetRequest): Promise<RecsResult> {
    try {
      const recipeHandle = typeof req?.recipe === 'string' ? req.recipe : ''
      if (recipeHandle === '') {
        logger.warn('recs.get called with an empty recipe; returning served:false')
        return miss('', false)
      }

      const datafile = getDatafile()
      if (!datafile) {
        logger.debug(`SDK not ready, returning served:false for recipe "${recipeHandle}"`)
        return miss(recipeHandle, false)
      }

      // The recipe registry is additive on FlagDatafile (older datafiles omit it).
      const recipes = (datafile as FlagDatafile & { recipes?: DatafileRecipe[] }).recipes
      const entry = recipes?.find((r) => r.recipe === recipeHandle) ?? null
      if (!entry) {
        logger.debug(`Recipe "${recipeHandle}" not present in datafile; returning served:false`)
        return miss(recipeHandle, false)
      }

      const seeds = resolveSeeds(req.context)
      const maxItems = clampMaxItems(req.maxItems)
      const excludeOutOfStock =
        typeof req.excludeOutOfStock === 'boolean' ? req.excludeOutOfStock : entry.excludeOutOfStock

      // The EXISTING resolve body — the worker's key cache resolves SDK keys
      // in the key field just like snippet keys. Single seed keeps the
      // seedKey form so both callers share edge-cache entries.
      const body: Record<string, unknown> = {
        snippetKey: sdkKey,
        assigned: 0,
        sources: [{ chain: entry.chain }],
        maxItems,
        excludeOutOfStock,
        merch: entry.merch ?? [],
        sessionAffinity: entry.sessionAffinity,
      }
      if (seeds.length === 1) body.seedKey = seeds[0]
      else body.seedKeys = seeds

      const base = datafile.collectEndpoint.replace(/\/+$/, '').replace('/v1/collect/batch', '')
      const res = await fetch(`${base}/v1/recs/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(requestTimeout),
      })
      if (!res.ok) {
        logger.warn('Recs resolve failed', { recipe: recipeHandle, status: res.status })
        return miss(recipeHandle, true)
      }

      const parsed = (await res.json()) as { data?: ResolveWireData }
      const data = parsed?.data
      if (!data || typeof data !== 'object') return miss(recipeHandle, true)

      const items = toRecProducts(Array.isArray(data.items) ? data.items : [], maxItems)
      const servedStep = data.served ?? null
      const served = servedStep !== null && items.length > 0

      // Attribution is opt-in: one rec:impression per successful resolve,
      // only when the caller supplied the ids.
      if (req.attribution) {
        const tracker = getTracker()
        if (tracker) {
          tracker.queue({
            visitorId: req.attribution.visitorId,
            experimentId: req.attribution.experimentId,
            variationId: req.attribution.variationId,
            eventName: 'rec:impression',
            revenue: null,
            timestamp: Date.now(),
            pageUrl: '',
            attributes: {
              recipe: entry.recipe,
              seed: joinIds(seeds),
              slug: servedStep?.slug ?? '',
              version: servedStep ? String(servedStep.version) : '',
              step: servedStep ? String(servedStep.step) : '',
              served: served ? 'true' : 'false',
              items: joinIds(items.map((i) => i.id)),
            },
          })
        } else {
          logger.warn('recs.get attribution supplied before tracker is ready; impression dropped')
        }
      }

      return {
        items,
        served,
        recipe: entry.recipe,
        source: servedStep?.slug ?? null,
        fallbackStep: servedStep?.step ?? null,
        degraded: false,
      }
    } catch (e) {
      logger.warn('Recs resolve error', {
        recipe: typeof req?.recipe === 'string' ? req.recipe : '',
        error: String(e),
      })
      return miss(typeof req?.recipe === 'string' ? req.recipe : '', true)
    }
  }

  function trackClick(
    productId: string,
    opts: RecsAttribution & { position?: number; recipe?: string },
  ): void {
    if (typeof productId !== 'string' || productId === '') {
      logger.warn('recs.trackClick called with an empty productId; dropped')
      return
    }
    if (!opts || !opts.visitorId || !opts.experimentId || !opts.variationId) {
      logger.warn('recs.trackClick requires visitorId/experimentId/variationId; dropped')
      return
    }
    const tracker = getTracker()
    if (!tracker) {
      logger.warn('recs.trackClick called before tracker is ready; click dropped')
      return
    }
    const position =
      typeof opts.position === 'number' && Number.isInteger(opts.position) && opts.position >= 1
        ? String(opts.position)
        : ''
    tracker.queue({
      visitorId: opts.visitorId,
      experimentId: opts.experimentId,
      variationId: opts.variationId,
      eventName: 'rec:click',
      revenue: null,
      timestamp: Date.now(),
      pageUrl: '',
      attributes: {
        recipe: typeof opts.recipe === 'string' ? opts.recipe : '',
        item: productId.slice(0, MAX_ID_CHARS),
        position,
      },
    })
  }

  return { get, trackClick }
}
