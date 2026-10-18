/**
 * `@avsbhq/nuxt/server`: the server half of the module.
 *
 * Two ways to get a datafile into the page, and one shared vocabulary for
 * where it is stored:
 *
 * 1. Do nothing. The module's plugin fetches the datafile during server
 *    rendering (deduplicated and cached across requests) and puts it in the
 *    payload. This is the default.
 *
 * 2. You already run an `AvsbServer` from `@avsbhq/node` for server-side
 *    evaluation. Hand its datafile over instead of paying for a second fetch:
 *
 *    ```ts
 *    // plugins/avsb-bootstrap.server.ts
 *    import { AVSB_BOOTSTRAP_STATE_KEY, getAvsbBootstrap } from '@avsbhq/nuxt/server'
 *    import { avsbServer } from '../server/avsb'
 *
 *    export default defineNuxtPlugin(() => {
 *      const bootstrap = useState(AVSB_BOOTSTRAP_STATE_KEY, () => null)
 *      bootstrap.value = getAvsbBootstrap(avsbServer)
 *    })
 *    ```
 *
 *    The module's own plugin runs with `enforce: 'post'`, so a plugin like
 *    that one has already run and the module leaves the value alone.
 *
 * `getAvsbBootstrap` is the same helper, with the same name and the same
 * meaning, that `@avsbhq/svelte/sveltekit` and `@avsbhq/solid/solid-start`
 * ship: it hands back the DATAFILE, which is exactly what the browser client's
 * `bootstrap` option takes.
 */
import { fetchDatafile } from '@avsbhq/browser/server';
import type { EvalContext, FlagDatafile } from '@avsbhq/core';
import {
  DEFAULT_BOOTSTRAP_MAX_AGE_MS,
  DEFAULT_BOOTSTRAP_TIMEOUT_MS,
  DEFAULT_CDN_HOST,
} from './options';

// ---------------------------------------------------------------------------
// Payload keys
//
// `AVSB_BOOTSTRAP_STATE_KEY` holds the datafile for this request: set it and
// the browser client starts ready and fetches nothing before the first paint.
// `AVSB_CONTEXT_STATE_KEY` holds the evaluation context for this request: set
// it in a server plugin (from a cookie, a session, whatever you already have)
// and the server render and the browser client evaluate for the same visitor.
//
// They live in their own module so the runtime plugin can import them without
// importing the fetch helper below.
// ---------------------------------------------------------------------------

export { AVSB_BOOTSTRAP_STATE_KEY, AVSB_CONTEXT_STATE_KEY } from './stateKeys';

// ---------------------------------------------------------------------------
// Bring your own server client
// ---------------------------------------------------------------------------

/** The slice of `@avsbhq/node`'s `AvsbServer` this helper reads. */
export interface AvsbServerClient {
  getDatafile(): FlagDatafile | null;
}

/**
 * The datafile to put in the payload, taken from a server client you already
 * run.
 *
 * JSON-safe by construction: it is the same document the CDN serves. Returns
 * null when the server client has not loaded one yet (its first request, or a
 * failed fetch), and the browser client then fetches its own.
 */
export function getAvsbBootstrap(serverClient: AvsbServerClient): FlagDatafile | null {
  return serverClient.getDatafile();
}

// ---------------------------------------------------------------------------
// The module's own fetch path
// ---------------------------------------------------------------------------

export interface LoadDatafileOptions {
  cdnHost?: string;
  /** Milliseconds before the fetch is abandoned. Default 3000. */
  timeoutMs?: number;
  /** Milliseconds a fetched datafile is reused across requests. Default 60000. */
  maxAgeMs?: number;
  onError?: (error: Error) => void;
}

/** `fetchDatafile` from `@avsbhq/browser/server`, or a stand-in for tests. */
export type DatafileFetcher = (
  sdkKey: string,
  options: {
    cdnHost?: string;
    timeout?: number;
    onError?: (error: Error) => void;
  },
) => Promise<FlagDatafile | null>;

export interface DatafileLoader {
  load(sdkKey: string, options?: LoadDatafileOptions): Promise<FlagDatafile | null>;
  /** Drop everything cached. Tests use it; so can a deployment hook. */
  clear(): void;
}

interface CacheEntry {
  datafile: FlagDatafile;
  fetchedAt: number;
}

/**
 * A datafile loader with a small TTL cache and in-flight deduplication.
 *
 * Two properties matter under server rendering:
 *
 * - A burst of concurrent requests triggers ONE fetch, not one per request.
 * - A failed fetch is never cached. The next request tries again rather than
 *   serving defaults for a whole TTL because one fetch timed out.
 */
export function createDatafileLoader(options?: {
  fetchDatafile?: DatafileFetcher;
  now?: () => number;
}): DatafileLoader {
  const fetcher: DatafileFetcher = options?.fetchDatafile ?? fetchDatafile;
  const now: () => number = options?.now ?? (() => Date.now());

  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<FlagDatafile | null>>();

  return {
    async load(sdkKey, loadOptions): Promise<FlagDatafile | null> {
      const cdnHost = loadOptions?.cdnHost ?? DEFAULT_CDN_HOST;
      const maxAgeMs = loadOptions?.maxAgeMs ?? DEFAULT_BOOTSTRAP_MAX_AGE_MS;
      const key = `${sdkKey}|${cdnHost}`;

      const cached = cache.get(key);
      if (cached && now() - cached.fetchedAt < maxAgeMs) return cached.datafile;

      const pending = inFlight.get(key);
      if (pending) return pending;

      const request = fetcher(sdkKey, {
        cdnHost,
        timeout: loadOptions?.timeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
        ...(loadOptions?.onError ? { onError: loadOptions.onError } : {}),
      })
        .then((datafile) => {
          // Only a real datafile is cached. `fetchDatafile` answers null on
          // every failure (bad key, network, timeout), and caching that would
          // turn one bad second into a whole TTL of default values.
          if (datafile) cache.set(key, { datafile, fetchedAt: now() });
          return datafile;
        })
        .finally(() => {
          inFlight.delete(key);
        });

      inFlight.set(key, request);
      return request;
    },

    clear(): void {
      cache.clear();
      inFlight.clear();
    },
  };
}

/**
 * The loader the module's plugin uses. One per server process, so a datafile
 * fetched for one request serves the next.
 */
export const avsbDatafileLoader: DatafileLoader = createDatafileLoader();

export type { EvalContext, FlagDatafile };
