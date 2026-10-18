# @avsbhq/edge

Feature flags and experiments at the edge, for the [A vs B](https://app.avsb.cloud) platform.

One package, seven runtimes: Cloudflare Workers, Vercel Edge Functions, Fastly Compute, Netlify Edge Functions, Deno Deploy, Bun, and AWS Lambda@Edge. Built on `@avsbhq/core`. Each adapter handles that platform's request lifecycle, its datafile cache, and its deferred-work mechanism.

Every code block on this page is written to compile against the real types in `src/`.

---

## 1. Install

```bash
npm install @avsbhq/edge
```

No mandatory peer dependencies. Platform types are declared structurally inside each adapter, so you never install `@cloudflare/workers-types`, `@vercel/edge-config`, `@fastly/js-compute`, or `@types/aws-lambda` just to use this package.

---

## 2. Quickstart

Every adapter follows the same shape: you give it an SDK key and a handler, it gives you back the runtime's native handler signature. The client inside your handler is already initialised and already bound to the visitor from the request, so `client.getBoolFlag('key', false)` needs no context argument.

### Cloudflare Workers

Cloudflare exposes secrets and KV bindings only on the `env` argument of `fetch`, so `sdkKey` and `kv` also accept a function of `env`.

```ts
import { createCloudflareHandler } from '@avsbhq/edge/cloudflare';
import type { KVNamespace } from '@avsbhq/edge/cloudflare';

interface Env {
  AVSB_SDK_KEY: string;
  AVSB_KV: KVNamespace;
}

export default {
  fetch: createCloudflareHandler<Env>({
    sdkKey: (env) => env.AVSB_SDK_KEY,
    kv: (env) => env.AVSB_KV,
    handler: async (req, client) => {
      const checkout = client.getBoolFlag('new_checkout', false);
      return Response.json({ enabled: checkout.isEnabled() });
    },
  }),
};
```

### Vercel Edge Functions

```ts
import { createVercelHandler } from '@avsbhq/edge/vercel';
import { createClient } from '@vercel/edge-config';

export const runtime = 'edge';

const avsb = createVercelHandler({
  sdkKey: process.env.AVSB_SDK_KEY ?? '',
  edgeConfig: createClient(process.env.EDGE_CONFIG),
  handler: async (req, client) => {
    const hero = client.getStringFlag('homepage_hero', 'control');
    return Response.json({ variant: hero.value });
  },
});

export function GET(req: Request): Promise<Response> {
  return avsb(req);
}
```

### Fastly Compute

The handler takes the whole fetch event, because Fastly hangs geolocation and the client address off `event.client`. `kvStore` takes a thunk, because Fastly forbids constructing platform resources during global initialisation.

```ts
/// <reference types="@fastly/js-compute" />
// docs-example: not typechecked here, because Fastly's global types ship with
// @fastly/js-compute, which this repo does not install, so addEventListener
// resolves to the DOM's own Event here.
import { createFastlyHandler } from '@avsbhq/edge/fastly';
import { KVStore } from 'fastly:kv-store';

const avsb = createFastlyHandler({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  kvStore: () => new KVStore('avsb-datafiles'),
  handler: async (req, client) => {
    const flag = client.getBoolFlag('new_checkout', false);
    return Response.json({ enabled: flag.isEnabled() });
  },
});

addEventListener('fetch', (event) => event.respondWith(avsb(event)));
```

### Netlify Edge Functions

```ts
// docs-example: not typechecked here, because the Netlify global ships with
// the Netlify Edge runtime rather than from npm, so this repo has nothing to
// check Netlify.env against.
import { createNetlifyHandler } from '@avsbhq/edge/netlify';

export default createNetlifyHandler({
  sdkKey: Netlify.env.get('AVSB_SDK_KEY') ?? '',
  handler: async (req, client) => {
    const theme = client.getStringFlag('theme', 'light');
    return Response.json({ theme: theme.value });
  },
});

export const config = { path: '/api/theme' };
```

### Deno Deploy

```ts
// docs-example: not typechecked here, because Deno's global types ship with
// the deno CLI rather than from npm, so this repo has nothing to check
// Deno.openKv, Deno.env and Deno.serve against.
import { createDenoHandler } from '@avsbhq/edge/deno';

const kv = await Deno.openKv();

Deno.serve(
  createDenoHandler({
    sdkKey: Deno.env.get('AVSB_SDK_KEY') ?? '',
    kv,
    handler: async (req, client) => {
      const dark = client.getBoolFlag('dark_mode', false);
      return Response.json({ darkMode: dark.value });
    },
  }),
);
```

### Bun

```ts
// docs-example: not typechecked here, because Bun's global types ship with the
// bun runtime rather than from npm, so this repo has nothing to check Bun.serve
// and Bun.env against.
import { createBunHandler } from '@avsbhq/edge/bun';

Bun.serve({
  port: 3000,
  fetch: createBunHandler({
    sdkKey: Bun.env.AVSB_SDK_KEY ?? '',
    handler: async (req, client) => {
      const pageSize = client.getNumberFlag('page_size', 25);
      return Response.json({ pageSize: pageSize.value });
    },
  }),
});
```

### AWS Lambda@Edge

Return a `Response` to answer from the edge, or return nothing to let CloudFront continue to the origin with the request as you left it.

```ts
import { createLambdaEdgeHandler } from '@avsbhq/edge/lambda';

export const handler = createLambdaEdgeHandler({
  sdkKey: process.env.AVSB_SDK_KEY ?? '',
  handler: async (req, client, cfRequest) => {
    const redesign = client.getBoolFlag('hero_redesign', false);
    if (redesign.isEnabled()) {
      cfRequest.uri = `/v2${cfRequest.uri}`;
    }
  },
});
```

---

## 3. SDK keys

Use the environment SDK key for the environment you are serving, shaped `sdk_<environment>_<id>`. Copy it from app.avsb.cloud, then Environments in the project sidebar.

The key is validated at construction. A value that does not look like an SDK key logs an error naming what it looks like instead (a pasted URL, a personal access token, a truncated copy) and the client keeps going, so a 404 on the next datafile request is explained rather than mysterious.

| Runtime            | Where the key lives                                                              |
| ------------------ | -------------------------------------------------------------------------------- |
| Cloudflare Workers | `wrangler secret put AVSB_SDK_KEY`, read via `sdkKey: (env) => env.AVSB_SDK_KEY` |
| Vercel Edge        | Project settings, Environment Variables                                          |
| Fastly Compute     | `fastly.env.get('AVSB_SDK_KEY')` or a config store                               |
| Netlify Edge       | Site settings, Environment Variables                                             |
| Deno Deploy        | Project settings, Environment Variables                                          |
| Bun                | `.env` or your platform's secret store                                           |
| Lambda@Edge        | Bundled at deploy time (Lambda@Edge does not support environment variables)      |

---

## 4. Identity

Each adapter builds an evaluation context from the request. You do not have to write one.

The default resolves the visitor in this order:

1. The `x-avsb-visitor-id` request header.
2. The A vs B snippet's `_avsb_visitor` cookie, when Web Experiments also runs on this site. Reading it means the edge SDK and the snippet report the same visitor, so both surfaces join in results.
3. Nothing. The context key is the empty string and the SDK warns once, naming both sources and the option to set.

The client IP is deliberately never used as the bucketing key. The bucketing key becomes `visitorId` on every exposure row, so bucketing on IP would write a personal identifier into analytics storage for every visitor. IP-derived country and city are used as targeting attributes, because those are not stable per-person identifiers.

### What each adapter extracts

Attribute names match the visitor-data factories in `@avsbhq/utils`, so an audience authored once targets the snippet and the edge alike. An attribute the platform does not provide is omitted, never written as an empty string, so an `exists` audience condition can tell "no geo on this platform" from "geo says empty".

| Adapter      | Identity                          | Geo source                                                                             | Geo attributes                                                              | Extra                      |
| ------------ | --------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------- |
| `cloudflare` | header, cookie                    | `request.cf`, falling back to the `cf-ipcountry` header                                | country, region, city, continent, postalCode, timezone, latitude, longitude | colo, asn                  |
| `vercel`     | header, cookie                    | `x-vercel-ip-*` headers (city is percent-decoded)                                      | country, region, city, timezone, latitude, longitude                        | none                       |
| `fastly`     | header, cookie                    | `event.client.geo` (snake_case mapped to the shared names)                             | country, region, city, continent, postalCode, latitude, longitude           | none                       |
| `netlify`    | header, cookie, `context.cookies` | `context.geo` (country and subdivision flattened)                                      | country, region, city, timezone, latitude, longitude                        | none                       |
| `deno`       | header, cookie                    | none, Deno Deploy exposes no geo                                                       | none                                                                        | region, from `DENO_REGION` |
| `bun`        | header, cookie                    | none, Bun is a runtime and not a network                                               | none                                                                        | none                       |
| `lambda`     | header, cookie                    | `cloudfront-viewer-*` headers, present only when the distribution policy forwards them | country, region, city, postalCode, timezone, latitude, longitude            | none                       |

Every adapter also sets `url`, `path`, `host` from the request URL and `userAgent`, `language`, `referrer` from headers.

### Writing your own

`contextFrom` is optional on every adapter. Supply one to replace the default, and build on the exported helpers so you keep the platform data:

```ts
import { createCloudflareHandler, cloudflareContextFrom } from '@avsbhq/edge/cloudflare';

export default {
  fetch: createCloudflareHandler({
    sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
    contextFrom: (req) => ({
      ...cloudflareContextFrom(req),
      key: req.headers.get('x-user-id') ?? 'anon',
      plan: req.headers.get('x-account-plan') ?? 'free',
    }),
    handler: async (req, client) => Response.json({ ok: client.isReady() }),
  }),
};
```

On Fastly, Deno, and Bun this is also how you add geo:

```ts
import { createFastlyHandler, fastlyContextFrom } from '@avsbhq/edge/fastly';

const avsb = createFastlyHandler({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  contextFrom: (event) => ({
    ...fastlyContextFrom(event),
    cartValue: Number(event.request.headers.get('x-cart-value') ?? 0),
  }),
  handler: async (req, client) => Response.json({ ok: client.isReady() }),
});
```

### Multi-context

Return a multi-context from `contextFrom` to target on more than one identity. Bucketing uses the `user` sub-context.

```ts
import { readVisitorId } from '@avsbhq/edge';
import type { EvalContext } from '@avsbhq/edge';
import { createVercelHandler } from '@avsbhq/edge/vercel';

function contextFrom(req: Request): EvalContext {
  return {
    kind: 'multi',
    user: { kind: 'user', key: readVisitorId(req.headers) ?? '' },
    organization: {
      kind: 'organization',
      key: req.headers.get('x-org-id') ?? 'none',
      tier: req.headers.get('x-org-tier') ?? 'free',
    },
  };
}

export const handler = createVercelHandler({
  sdkKey: process.env.AVSB_SDK_KEY ?? '',
  contextFrom,
  handler: async (req, client) => Response.json({ ok: client.isReady() }),
});
```

There is no `identify()` at the edge: the context is fixed for the life of one request.

---

## 5. Reading flags

The rest of this page names the package's own types, and shows methods on the client your handler receives. Both come from here:

```ts
import { AvsbEdgeClient } from '@avsbhq/edge';
import type {
  EdgeErrorSource,
  EdgeLogLevel,
  EvalContext,
  EvaluationSource,
  Flag,
  FlagDatafile,
  GetAllFlagsOptions,
  GetFlagOptions,
  InitResult,
  Logger,
  TrackPayload,
  UnifiedStorageAdapter,
} from '@avsbhq/edge';
import type { RuleType } from '@avsbhq/core';

const client = new AvsbEdgeClient({ sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn' });
```

```ts
getFlag<T>(flagKey: string, defaultValue: T, context?: EvalContext, options?: GetFlagOptions): Flag<T>
getBoolFlag(flagKey: string, defaultValue: boolean, context?: EvalContext, options?: GetFlagOptions): Flag<boolean>
getStringFlag(flagKey: string, defaultValue: string, context?: EvalContext, options?: GetFlagOptions): Flag<string>
getNumberFlag(flagKey: string, defaultValue: number, context?: EvalContext, options?: GetFlagOptions): Flag<number>
getJsonFlag<T>(flagKey: string, defaultValue: T, context?: EvalContext, options?: GetFlagOptions): Flag<T>
getAllFlags(context?: EvalContext, options?: GetAllFlagsOptions): Record<string, Flag>
```

`context` is optional because the adapter already bound one. Pass it to evaluate one call against a different identity without changing the bound context.

Every read returns a frozen `Flag<T>`:

```ts
interface Flag<T = unknown> {
  readonly value: T;
  readonly variationKey: string | null;
  readonly source: EvaluationSource;
  readonly ruleId: string | null;
  readonly ruleType: RuleType | null;
  readonly reasons: string[];
  readonly evaluatedAt: number;
  readonly durationMicros: number;
  isEnabled(): boolean;
  exists(): boolean;
}
```

`source` says where the value came from:

| Value              | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- |
| `rule`             | a targeting rule or experiment matched                         |
| `holdout`          | this visitor is held out of the flag                           |
| `bandit`           | a bandit rule chose the action                                 |
| `datafileOverride` | an operator pinned this visitor in the dashboard               |
| `runtimeOverride`  | your code pinned it at runtime                                 |
| `sticky`           | a stored assignment was reused                                 |
| `default`          | no rule matched, the flag's default variation was served       |
| `disabled`         | the flag is turned off, its default variation was served       |
| `not_found`        | the datafile loaded and this key is not in it                  |
| `not_ready`        | `init()` had not finished, so your `defaultValue` was returned |

`isEnabled()` is true only when the value came from a real decision (`rule`, `holdout`, `bandit`, `runtimeOverride`, `datafileOverride`, `sticky`) and is truthy. It is always false for `default`, `not_found`, `disabled`, and `not_ready`.

`exists()` is false for `not_found` and for `not_ready`, because with no datafile the question is not yet answerable.

### Typed getters and type mismatches

A typed getter checks the type the dashboard declares for the flag. On a mismatch it returns your default with `source: 'not_found'` and logs a line naming both types. It never coerces:

```ts
// Flag "theme" is declared as a string in the dashboard.
const size = client.getNumberFlag('theme', 25);
// size.value === 25, size.source === 'not_found', and one warning is logged.
```

`getJsonFlag<T>` types the value against `T` for you. It does not validate the shape field by field: the runtime check only rejects `undefined`.

### Bulk reads

`getAllFlags()` fires no exposure events by default. A bulk read is not a decision served to a visitor, and one exposure per flag would attribute every visitor to every experiment at once. Pass `{ fireExposures: true }` when you genuinely are serving all of them.

---

## 6. Tracking events

```ts
track(eventKey: string, payload?: TrackPayload): void
flushEvents(): Promise<void>
```

```ts
interface TrackPayload {
  /** Money in decimal MAJOR units of the project currency. Column `revenue`. */
  revenue?: number;
  /** Numeric metric value for average-value metrics. Column `value`. */
  value?: number;
  properties?: Record<string, unknown>;
  context?: EvalContext;
}
```

```ts
client.track('signup_completed'); // a count
client.track('purchase', { revenue: 49.99 }); // money
client.track('items_added', { value: 3 }); // a quantity
client.track('checkout_completed', { revenue: 99.5, value: 2 }); // both
```

`revenue` and `value` are two columns end to end, exactly as in the browser and node SDKs, so one conversion can carry money, a quantity, or both. Until 1.x this client sent `payload.value` into the `revenue` column and could never write `value` at all (breaking change B36): a quantity was recorded as money, and an edge-tracked average-value metric read empty. If you were relying on that, rename the field to `revenue`.

`payload.properties` is accepted for cross-runtime symmetry but is **not stored** on tracked events, because the metric ingestion body has no properties field. The SDK warns once naming `revenue` and `value` as the places for numbers, rather than shipping something that looks delivered and is gone. Exposure events do carry properties.

Exposures are automatic: reading a flag whose decision came from an experiment queues one.

### Flushing

`flushEvents()` sends everything the request produced: queued exposures, queued tracked events, and any deferred cache write or heartbeat. Each adapter already calls it correctly for its runtime, so you only call it yourself if you build the client by hand.

| Runtime                   | How the flush runs                                                 |
| ------------------------- | ------------------------------------------------------------------ |
| Cloudflare                | `ctx.waitUntil`, after the response                                |
| Vercel                    | `waitUntil` when a FetchEvent is passed, otherwise awaited         |
| Netlify                   | `context.waitUntil` when present, otherwise awaited                |
| Fastly, Deno, Lambda@Edge | awaited before the response, because the instance ends with it     |
| Bun                       | started without blocking, because Bun's loop outlives the response |

An edge invocation ends with its request, so a batch that cannot be delivered is lost rather than retried later. The failure log says exactly that, naming the endpoint, the status, and how many events went with it. One retry inside the request is on by default (`eventRetryAttempts`), and every attempt sends byte-identical event ids so ingestion deduplicates instead of double-counting.

### Where events go

Endpoints come from the datafile's `collectEndpoint`, composed through the endpoint contract in `@avsbhq/core`:

| What           | Path                                             |
| -------------- | ------------------------------------------------ |
| Exposures      | `POST {collectEndpoint}/v1/collect/batch`        |
| Tracked events | `POST {collectEndpoint}/v1/collect/metric-batch` |
| Liveness       | `POST {datafile.heartbeatEndpoint}`              |

The SDK key rides in the JSON body envelope, because the collect paths are shared by every key. Datafile reads are keyless by path: the key is the path segment, with no header, no query string, and no `Authorization`.

---

## 7. Lifecycle and readiness

```ts
init(): Promise<InitResult>
getInitResult(): InitResult | null
isReady(): boolean
getDatafile(): FlagDatafile | null
getContext(): EvalContext | undefined
```

```ts
interface InitResult {
  success: boolean;
  source: 'network' | 'bootstrap' | 'timeout' | 'error';
  error?: Error;
  degraded?: boolean;
}
```

`init()` never rejects and never runs twice: concurrent callers share one attempt.

| Situation                                       | Result                                                      |
| ----------------------------------------------- | ----------------------------------------------------------- |
| A `datafile` was passed as a bootstrap          | `{ success: true, source: 'bootstrap' }`                    |
| A cached datafile was still fresh               | `{ success: true, source: 'bootstrap' }`                    |
| The datafile was fetched                        | `{ success: true, source: 'network' }`                      |
| The fetch failed and a stale cached copy exists | `{ success: true, degraded: true, source: 'error', error }` |
| The fetch failed with nothing cached            | `{ success: false, source: 'error', error }`                |

`degraded: true` means one thing only: the SDK is serving a stale cached datafile after a failed refresh. Flags still evaluate, but a change published since then is not visible yet.

Reading a flag before `init()` finishes returns your default with `source: 'not_ready'` and warns once per flag key. Adapters await `init()` for you.

---

## 8. Caching

Two separate ideas, deliberately:

- **Freshness** is the client's `cacheTtlMs` (default 5 minutes). Past it, the client revalidates over the network, and if that fails it serves the stale copy with `degraded: true`.
- **Retention** is how long an adapter's store keeps an entry at all. It is garbage collection, nothing more: Cloudflare KV defaults to 24 hours (`kvRetentionSeconds`), the Vercel and Bun in-process maps default to 1 hour (`memoryRetentionMs`).

Keeping them apart is what makes the degraded path reachable. A store that hard-expired at the freshness window would leave nothing to fall back on when the CDN is unreachable.

Vercel Edge Config is read-only at runtime, so `datafileSet` warms the in-process map only. Populate the Edge Config key `avsb_df_<sdkKey>` from CI if you want a shared cache.

---

## 9. Logging and error handling

```ts
logger?: Logger
logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent'
onError?: (error: Error, source: 'init' | 'cache' | 'events' | 'heartbeat') => void
```

Unlike the browser SDK, the edge default is never silent. A browser console belongs to your end user; a Worker's log stream belongs to you, and there is no build step that flips a production define for a Worker. The default is console at `warn`, or `debug` when `globalThis.__AVSB_DEV__` is true or `NODE_ENV` is a development value.

Configuration-level messages are deduplicated for the life of the isolate, so a Worker serving ten thousand requests with a bad key logs it once, not ten thousand times.

Set `logLevel: 'silent'` for no output at all.

```ts
import { createCloudflareHandler } from '@avsbhq/edge/cloudflare';

const avsb = createCloudflareHandler({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  clientOptions: {
    logLevel: 'debug',
    onError: (error, source) => {
      if (source === 'init') console.error('avsb init failed', error.message);
    },
  },
  handler: async (req, client) => Response.json({ ok: client.isReady() }),
});
```

The SDK never throws from a read, a track, or a flush.

---

## 10. Client options

Every field, as declared in `src/types.ts`:

```ts
interface EdgeClientOptions {
  sdkKey: string;
  context?: EvalContext;
  datafile?: FlagDatafile;
  fetchDatafile?: (sdkKey: string) => Promise<FlagDatafile | null>;
  cdnHost?: string;
  storage?: UnifiedStorageAdapter;
  cacheTtlMs?: number;
  timeoutMs?: number;
  heartbeat?: boolean;
  waitUntil?: (p: Promise<unknown>) => void;
  pageUrl?: string;
  logger?: Logger;
  logLevel?: EdgeLogLevel;
  onError?: (error: Error, source: EdgeErrorSource) => void;
  maxQueueSize?: number;
  eventRetryAttempts?: number;
}
```

Adapters own `sdkKey`, `storage`, `waitUntil`, `context`, and `pageUrl`, because all five are derived from the request and the bindings you gave them. Everything else is passed through `clientOptions`.

Defaults: `cacheTtlMs` 300000, `timeoutMs` 3000, `heartbeat` true, `maxQueueSize` 500, `eventRetryAttempts` 1.

---

## 11. Using the client directly

If you own the request lifecycle, skip the adapters:

```ts
import { AvsbEdgeClient, readVisitorId } from '@avsbhq/edge';

export async function handle(req: Request): Promise<Response> {
  const client = new AvsbEdgeClient({
    sdkKey: process.env.AVSB_SDK_KEY ?? '',
    context: { kind: 'user', key: readVisitorId(req.headers) ?? '' },
    pageUrl: req.url,
  });

  await client.init();

  const flag = client.getBoolFlag('new_checkout', false);
  const response = Response.json({ enabled: flag.isEnabled() });

  await client.flushEvents();
  return response;
}
```

`init()` resolves `{ success: false }` when there was nothing to serve. The SDK has already logged why, so branching on it is optional: flags return the defaults you passed either way.

There is nothing to close: an edge client lives for one request and has no timers, no sockets, and no global state.

---

## 12. Testing

Pass a datafile as a bootstrap and no network call happens:

```ts
import { AvsbEdgeClient } from '@avsbhq/edge';
import type { FlagDatafile } from '@avsbhq/edge';

const datafile: FlagDatafile = {
  version: 2,
  projectType: 'FEATURE_FLAG',
  sdkKey: 'sdk_test_aaaaaaaaaaaaaaaaaaaaaaaa',
  environmentKey: 'test',
  publishedAt: '2026-01-01T00:00:00.000Z',
  collectEndpoint: 'https://ingest.avsb.cloud',
  flags: [
    {
      id: 'flag_1',
      key: 'new_checkout',
      type: 'boolean',
      enabled: true,
      defaultVariationId: 'var_off',
      variations: [
        { id: 'var_on', key: 'on', value: true },
        { id: 'var_off', key: 'off', value: false },
      ],
      overrides: [],
      rules: [
        {
          id: 'rule_1',
          type: 'targeted_delivery',
          enabled: true,
          audienceIds: [],
          hashAttribute: 'userId',
          trafficAllocation: 1,
          variations: [{ variationId: 'var_on', percentage: 1 }],
        },
      ],
    },
  ],
  audiences: [],
};

const client = new AvsbEdgeClient({
  sdkKey: 'sdk_test_aaaaaaaaaaaaaaaaaaaaaaaa',
  datafile,
  context: { kind: 'user', key: 'user_42' },
  logLevel: 'silent',
});
await client.init();

client.getBoolFlag('new_checkout', false).value; // true
```

Set `logLevel: 'silent'` in tests so SDK diagnostics stay out of your output.

---

## 13. Breaking changes in 1.x

**B7. The event wire format changed.** Older builds posted `{sdkKey, events: [{eventKey, context, value, properties, timestamp}]}` to the bare `collectEndpoint` with no `/v1/collect/*` path and no event ids. Nothing on the platform accepted that shape, so no edge event was ever recorded. Events now go to `/v1/collect/batch` and `/v1/collect/metric-batch` in the format every other A vs B SDK uses. `buildCollectPayload` and `CollectEventPayload` are deleted; use `client.track` and `client.flushEvents`.

Also changed in the same release, all of which were broken rather than merely different:

- The datafile URL is `{cdnHost}/{sdkKey}/datafile.json`. It used to be `{cdnHost}/datafiles/{sdkKey}.json`, which 404s.
- Evaluation fires exposures. It used to pass no exposure hook, so edge experiments produced no data.
- `contextFrom` is called, and is optional because each adapter has a real default. It used to be declared and never called.
- `init()` returns an `InitResult` instead of `void`.
- A read before `init()` reports `not_ready` instead of `not_found`.
- The Fastly handler takes the fetch event rather than the request, so geolocation is reachable.
- The Lambda@Edge handler may return nothing to continue to the origin, and its responses now carry a body.
- `createCloudflareHandler` accepts `sdkKey` and `kv` as functions of `env`.
- Typed getters (`getBoolFlag`, `getStringFlag`, `getNumberFlag`, `getJsonFlag`) exist. The old README documented them; the code did not have them.

- The default logger prints instead of dropping everything.

**B36. `track` writes both numeric columns.** `payload.revenue` now lands in the wire's `revenue` column and `payload.value` in the separate `value` column, matching the browser, node, Python, Ruby and PHP SDKs and the locked wire fixture. This client used to send `payload.value` into `revenue` and never set `value`, so a quantity was stored as money and an edge-tracked average-value metric read empty. Rename the field to `revenue` wherever you were tracking money.

---

## 14. Migration

### From LaunchDarkly Cloudflare

| LaunchDarkly                                  | `@avsbhq/edge/cloudflare`                               |
| --------------------------------------------- | ------------------------------------------------------- |
| `init(sdkKey, { kvNamespace })`               | `createCloudflareHandler({ sdkKey, kv, handler })`      |
| `client.variation('key', ctx, default)`       | `client.getBoolFlag('key', default).value`              |
| `client.variationDetail('key', ctx, default)` | `client.getFlag('key', default)`                        |
| `client.flush()`                              | handled by the adapter, or `await client.flushEvents()` |

### From Statsig Edge

| Statsig                          | `@avsbhq/edge`                                          |
| -------------------------------- | ------------------------------------------------------- |
| `StatsigServer.initialize(key)`  | `createCloudflareHandler({ sdkKey, handler })`          |
| `checkGate(user, 'gate')`        | `client.getBoolFlag('gate', false).isEnabled()`         |
| `logEvent(user, 'event', value)` | `client.track('event', { value })`                      |
| `flush()`                        | handled by the adapter, or `await client.flushEvents()` |

Differences worth knowing:

- Every adapter is per request. There is no singleton to initialise and no process-wide state.
- The datafile is cached in the runtime's own store, not refetched on every request.
- Multi-context is native: return `{ kind: 'multi', ... }` from `contextFrom`.
- There is no `setInterval` and no `EventSource`, because edge environments have no persistent event loop.
