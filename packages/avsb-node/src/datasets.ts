import type { FlagDatafile, Logger } from '@avsbhq/core'

/**
 * Server-side datasets read client (e-commerce suite Phase 2).
 *
 * Resolves the live version of a dataset from the SDK's datafile
 * (`datasets` field) and fetches a single key from the edge worker:
 *
 *   GET {ingestionHost}/v1/ds/{sdkKey}/{slug}/{versionShortId}/{key}
 *
 * The ingestion host is derived from the datafile's `collectEndpoint`,
 * exactly like the server tracker derives `/v1/collect/*`. The worker's
 * key cache resolves SDK keys as well as snippet keys in the first path
 * segment.
 *
 * Error posture matches flag evaluation: this client NEVER throws.
 * Unknown slug, missing live version, SDK not ready, HTTP errors and
 * network failures all degrade to `{ found: false }`.
 */

export interface DatasetGetResult {
  found: boolean
  /** Parsed row for TABLE/FEED datasets; `true` for LIST membership hits. */
  value?: unknown
  meta: {
    slug: string
    /** Live version short id used for the lookup; null when unresolvable. */
    version: number | null
  }
}

export interface DatasetsClient {
  /**
   * Look up `key` in the live version of dataset `slug`.
   * Resolves the version from the current datafile and never throws.
   */
  get(slug: string, key: string): Promise<DatasetGetResult>
}

export interface DatasetsClientOptions {
  sdkKey: string
  /** Live datafile accessor; reads the SDK's current datafile on every call. */
  getDatafile: () => FlagDatafile | null
  logger: Logger
  /** Per-request timeout in ms. Defaults to 10s (same as the tracker). */
  requestTimeout?: number
}

const DEFAULT_REQUEST_TIMEOUT = 10_000

function miss(slug: string, version: number | null): DatasetGetResult {
  return { found: false, meta: { slug, version } }
}

export function createDatasetsClient(options: DatasetsClientOptions): DatasetsClient {
  const { sdkKey, getDatafile, logger } = options
  const requestTimeout = options.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT

  async function get(slug: string, key: string): Promise<DatasetGetResult> {
    if (!slug || !key) {
      logger.warn('datasets.get called with an empty slug or key; returning not found')
      return miss(slug, null)
    }

    const datafile = getDatafile()
    if (!datafile) {
      logger.debug(`SDK not ready, returning not found for dataset "${slug}"`)
      return miss(slug, null)
    }

    const dataset = datafile.datasets?.find((d) => d.slug === slug)
    if (!dataset) {
      logger.debug(`Dataset "${slug}" not present in datafile; returning not found`)
      return miss(slug, null)
    }
    if (!dataset.liveVersion) {
      logger.debug(`Dataset "${slug}" has no live version; returning not found`)
      return miss(slug, null)
    }

    const base = datafile.collectEndpoint.replace(/\/+$/, '')
    const url =
      `${base}/v1/ds/${encodeURIComponent(sdkKey)}/${encodeURIComponent(slug)}` +
      `/${dataset.liveVersion}/${encodeURIComponent(key)}`

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(requestTimeout) })
      if (!res.ok) {
        logger.warn('Dataset lookup failed', { slug, key, status: res.status })
        return miss(slug, dataset.liveVersion)
      }
      const body = (await res.json()) as { found?: boolean; value?: unknown }
      if (!body || body.found !== true) {
        return miss(slug, dataset.liveVersion)
      }
      return {
        found: true,
        value: body.value,
        meta: { slug, version: dataset.liveVersion },
      }
    } catch (e) {
      logger.warn('Dataset lookup error', { slug, key, error: String(e) })
      return miss(slug, dataset.liveVersion)
    }
  }

  return { get }
}
