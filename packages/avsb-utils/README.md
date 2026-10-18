# @avsbhq/utils

Utility library for the [A vs B](https://app.avsb.cloud) SDK ecosystem.

Provides timing helpers, resilience primitives, structured logging, context builders, snapshot/bootstrap serialization, decision recording, OpenFeature integration, request-scoped middleware for eight frameworks, and unified storage adapters. Most utilities are accessed through `client.utils.*` on any `AvsbClient` or `AvsbServer` instance. Some primitives are also importable directly.

---

## 1. Install

```bash
npm install @avsbhq/utils
```

Install peer dependencies only for the features you use:

```bash
# For pino logger adapter
npm install pino

# For winston logger adapter
npm install winston

# For OpenFeature
npm install @openfeature/server-sdk   # or @openfeature/web-sdk for browser

# For Express middleware
npm install express

# For Fastify middleware
npm install fastify
```

Node.js 18 or later.

---

## 2. Quickstart

All utilities are available on the SDK client after construction:

```ts
import { AvsbClient } from '@avsbhq/browser';

const client = new AvsbClient({ sdkKey: '...', context: { kind: 'user', key: 'u_1' } });
await client.onReady();

// Use utilities through client.utils
const snapshot = client.utils.snapshot();
const debounced = client.utils.debounce((term: string) => console.log('search', term), 300);
const bootstrap = await client.utils.serializeBootstrap();
```

For server-side:

```ts
import { AvsbServer } from '@avsbhq/node';

const server = new AvsbServer({ sdkKey: process.env.AVSB_SDK_KEY! });
await server.onReady();

// A sink is anything with a name and a write(batch) method.
const recorder = server.utils.createDecisionRecorder({
  sinks: [
    {
      name: 'console',
      async write(batch) {
        console.log('decisions', batch.length);
      },
    },
  ],
});
```

---

## 3. SDK keys

`@avsbhq/utils` contains no networking code and does not use SDK keys directly. SDK keys are managed by `@avsbhq/browser` and `@avsbhq/node`.

---

## 4. Identity

Not applicable as a standalone utility. Context helpers are available in the `context` sub-module:

```ts
import {
  defineContextSchema,
  mergeContext,
  redactAttributes,
  anonymousId,
  userContext,
} from '@avsbhq/utils';

// Shorthand context factory
const ctx = userContext('u_123', { plan: 'pro' });
// { kind: 'user', key: 'u_123', plan: 'pro' }

// Merge attributes into an existing context
const updated = mergeContext(ctx, { country: 'US' });

// Generate an anonymous ID (UUID v4)
const anonId = anonymousId();

// Redact private attributes before logging
const safe = redactAttributes(ctx, ['email', 'phone']);
```

---

## 5. Multi-context

```ts
import { defineContextSchema } from '@avsbhq/utils';
import { z } from 'zod';

const Ctx = defineContextSchema({
  user: z.object({ id: z.string(), plan: z.enum(['free', 'pro', 'enterprise']) }),
  organization: z.object({ id: z.string(), tier: z.number() }),
});

const ctx = Ctx.builder()
  .setUser('u_123', { id: 'u_123', plan: 'pro' })
  .setOrganization('org_456', { id: 'org_456', tier: 3 })
  .build();

// Validates at build time against the declared schema
const result = Ctx.validate(ctx);
if (!result.success) {
  /* handle errors */
}
```

`defineContextSchema` integrates with the CLI's `codegen` command (`npx @avsbhq/cli codegen`), which generates the schema file from your platform's declared `registeredAttributes`.

---

## 6. Timing helpers

```ts
import { once, debounce, throttle, retry, sleep, withTimeout, withDeadline } from '@avsbhq/utils';
```

The same seven are on any client, so a browser bundle can take them off `client.utils` instead of importing them again:

```ts
const { once, debounce, throttle, retry, sleep, withTimeout, withDeadline } = client.utils;

// Run a function exactly once (idempotent wrapper)
const initOnce = once(() => console.log('initialised'));
initOnce(); // runs
initOnce(); // no-op

// Debounce user input
const handleSearch = debounce((term: string) => console.log('search', term), 300);
handleSearch.cancel(); // cancel pending call

// Throttle scroll events
const handleScroll = throttle(() => console.log(window.scrollY), 16);

// Retry with backoff: 3 attempts, 100ms, doubling
const data = await retry(() => fetch('/api/data'), {
  attempts: 3,
  delay: 100,
  factor: 2,
});

// Add a timeout to any promise
const result = await withTimeout(fetch('/datafile.json'), 5000);

// Deadline (absolute ms timestamp)
const result2 = await withDeadline(fetch('/datafile.json'), Date.now() + 5000);

await sleep(50);
```

---

## 7. Resilience

```ts
import { FallbackChain, circuitBreaker } from '@avsbhq/utils';

const key = 'checkout_v2';
const memoryCache = new Map<string, string>();

// FallbackChain: try each layer in order, return the first that answers
const chain = new FallbackChain<string>([
  { name: 'memory', resolve: () => memoryCache.get(key) },
  { name: 'origin', resolve: () => fetch(`/cache/${key}`).then((r) => r.text()) },
  { name: 'default', resolve: () => 'control' },
]);
const hit = await chain.run();
// { value, source: 'memory' | 'origin' | 'default' }, or null when no layer answered

// Circuit breaker: open after N consecutive failures, half-open after the reset timeout
const safeFetch = circuitBreaker(() => fetch('/datafile.json'), {
  threshold: 5,
  resetTimeoutMs: 30_000,
});
```

A layer returning `null` or `undefined`, or throwing, hands over to the next one. `run()` resolves `null` only when every layer came back empty.

---

## 8. Structured logging

```ts
import { createLogger, consoleLogger, noopLogger } from '@avsbhq/utils';
import { createPinoTransport } from '@avsbhq/utils/log/pino';
import { createWinstonTransport } from '@avsbhq/utils/log/winston';
import pino from 'pino';
import winston from 'winston';

// Console logger (default, zero deps)
const logger = consoleLogger('warn');

// Multi-transport pino logger
const pinoLogger = createLogger({
  level: 'info',
  prefix: 'avsb',
  transports: [createPinoTransport({ logger: pino(), level: 'info' })],
});

// Winston adapter
const winstonLogger = createLogger({
  level: 'info',
  transports: [createWinstonTransport({ logger: winston.createLogger(), level: 'warn' })],
});

// Child logger (inherits parent settings, scoped prefix)
const requestLogger = logger.child('request-handler');
requestLogger.info('flag evaluated', { flagKey: 'checkout_v2' });

// Pass to the SDK
const sdkKey = process.env.AVSB_SDK_KEY!;
const loggingServer = new AvsbServer({ sdkKey, logger: pinoLogger });
```

---

## 9. Context builder and visitor data

```ts
import { AvsbClient } from '@avsbhq/browser';

const client = new AvsbClient({ sdkKey, context: { kind: 'user', key: 'u_1' } });

// Pre-built context factories for common web signals
const browserCtx = client.utils.context.Browser();
// { kind: 'device', key: fingerprint, os: 'macos', browser: 'chrome', viewport: '...', ... }

const geoCtx = client.utils.context.Geolocation({ country: 'US', region: 'CA' });
// { kind: 'geo', key: 'US:CA', country: 'US', region: 'CA' }

const pageCtx = client.utils.context.PageView({ url: window.location.href });
// { kind: 'pageview', key: pathname, path: '/checkout', referrer: '...' }
```

---

## 10. Snapshots and bootstrap

```ts
import type { KVNamespace } from '@avsbhq/utils';

declare const kvNamespace: KVNamespace; // your Workers KV binding

// Synchronous snapshot of all current flag values
const snap = client.utils.snapshot();
// { capturedAt: 1717000000000, datafileVersion: '...', flags: { 'key': Flag<T> }, contextSummary: [...] }

// Force-refresh datafile then snapshot
const fresh = await client.utils.snapshotFresh();

// SSR bootstrap: serialize for handoff to the client
const blob = await client.utils.serializeBootstrap(ctx, { includeDatafile: true });
// { format: 'avsb-bootstrap-v1', snapshot: {...}, datafile: {...}, producedAt: ... }

// Client: consume the bootstrap blob (skips the initial network fetch)
const applied = client.utils.hydrateBootstrap(blob);
// { datafileApplied: true, snapshotApplied: true, flagCount: 12 }

// Load a datafile from a URL, KV store, or filesystem
const df = await client.utils.bootstrapFromUrl(
  'https://cdn.avsb.cloud/sdk_production_ttqm0eaj4vth1krcb2xn/datafile.json',
);
const df2 = await client.utils.bootstrapFromKV(kvNamespace, 'my-datafile'); // Workers KV binding
const df3 = await client.utils.bootstrapFromFile('/etc/avsb/datafile.json');
```

### What hydration actually does

```ts
interface HydrateBootstrapResult {
  /** The blob carried a datafile and the client adopted it. */
  datafileApplied: boolean;
  /** The client adopted the pre-evaluated snapshot. */
  snapshotApplied: boolean;
  /** Flag keys the snapshot carried. */
  flagCount: number;
}
```

A blob has two halves, and clients accept them differently:

- **`datafile`** (present when you pass `includeDatafile: true`): the browser client and the server client both adopt it and evaluate locally from then on.
- **`snapshot`**: values the server already evaluated for ONE context. The browser client adopts them and answers reads from them until a real datafile arrives, then releases them. Each flag keeps the `source` the server recorded and gains one reason naming the snapshot and its capture time, so the provenance is never hidden. Reads fire no exposures: the server already decided whether to record one.

The SERVER client deliberately does not adopt snapshots. One snapshot belongs to one context while a server evaluates a different context per request, so seeding it process-wide would serve one user's values to another. Handing a snapshot-only blob to a server client THROWS with that explanation, instead of doing nothing, which is what the whole path used to do: neither hook existed, so every `hydrateBootstrap` call was silently a no-op.

---

## 11. Change streams

```ts
// Async iterator over flagChange events
for await (const change of client.utils.changes()) {
  console.info('flag changed', {
    flagKey: change.flagKey,
    from: change.previousValue,
    to: change.newValue,
  });
}

// Typed per-flag callback
const unsub = client.utils.onFlagChange('checkout_v2', (flag) => {
  analytics.track('flag_updated', { value: flag.value });
});
unsub(); // stop listening

// Wait for a flag to reach a specific value (with optional timeout)
const flag = await client.utils.waitForFlag('feature_gate', (f) => f.isEnabled(), {
  timeout: 10_000,
});
```

---

## 12. Decision recorder and warehouse sinks

Record every flag evaluation and stream it to one or more sinks for analytics, compliance, or debugging:

```ts
import { createOtelSink, createSnowflakeSink } from '@avsbhq/utils';
import { SDK_VERSION } from '@avsbhq/node';

// Whatever you already run. Both sinks accept anything with these methods.
declare const myOtelExporter: {
  export(
    spans: Array<{ name: string; attributes: Record<string, unknown>; startTime: number }>,
  ): Promise<void>;
};
declare const snowflakeConn: {
  execute(opts: { sqlText: string; binds?: unknown[][] }): Promise<{ rowCount: number }>;
};

const recorder = server.utils.createDecisionRecorder({
  sample: 0.1, // record 10% of decisions
  privateAttributes: ['email', 'ip'], // redact before forwarding
  bufferSize: 1000,
  flushInterval: 5000,
  sinks: [
    createOtelSink({ exporter: myOtelExporter }),
    createSnowflakeSink({
      connection: snowflakeConn,
      table: 'avsb_decisions',
      sdkKey,
      sdkVersion: SDK_VERSION,
    }),
  ],
});

// Feed it from a bound client's decision log, which already carries the
// DecisionLogEntry shape (flag fields plus the context kind and key).
const user = server.forUser({ kind: 'user', key: 'u_123' });
user.getBoolFlag('checkout_v2', false);
for (const entry of user.getDecisionLog().entries) {
  recorder.record(entry);
}

// Flush and close on shutdown
await recorder.close();
```

Available sinks:

- `createOtelSink`: OpenTelemetry exporter
- `createSentrySink`: Sentry client
- `createDatadogSink`: Datadog HTTP API
- `createSnowflakeSink`: Snowflake Node connector
- `createBigQuerySink`: `@google-cloud/bigquery`
- `createRedshiftSink`: Redshift Data API (aws-sdk-js-v3)
- `createClickHouseSink`: `@clickhouse/client`

---

## 13. Request-scoped middleware

Eight framework adapters. All open an `AsyncLocalStorage` scope so `getRequestClient()` works anywhere in the call chain without passing the client explicitly.

### Express

```ts
import express from 'express';
import { expressMiddleware } from '@avsbhq/utils/middleware/express';
import { getRequestClient } from '@avsbhq/utils';

const app = express();

app.use(
  expressMiddleware(server, {
    // The middleware reads the request structurally, so narrow it to whatever
    // your auth layer put there.
    contextFrom: (req) => {
      const authed = req.user as { id?: string } | undefined;
      return { kind: 'user', key: authed?.id ?? 'anon' };
    },
  }),
);

// In any nested function, no need to pass client. It is null outside a request.
function myService() {
  return getRequestClient()?.getBoolFlag('my_flag', false).value ?? false;
}
```

The other seven adapters, by their real export names:

| Subpath                              | Export                              | Shape                                                      |
| ------------------------------------ | ----------------------------------- | ---------------------------------------------------------- |
| `@avsbhq/utils/middleware/fastify`   | `fastifyPlugin`                     | `fastify.register(fastifyPlugin, { server, contextFrom })` |
| `@avsbhq/utils/middleware/hono`      | `honoMiddleware`                    | `app.use(honoMiddleware(server, { contextFrom }))`         |
| `@avsbhq/utils/middleware/koa`       | `koaMiddleware`                     | `app.use(koaMiddleware(server, { contextFrom }))`          |
| `@avsbhq/utils/middleware/nextApp`   | `nextAppHandler`, `withNextRequest` | wraps a route handler                                      |
| `@avsbhq/utils/middleware/nextPages` | `nextPagesApi`                      | wraps an API route                                         |
| `@avsbhq/utils/middleware/lambda`    | `lambdaHandler`                     | wraps a Lambda handler                                     |
| `@avsbhq/utils/middleware/workers`   | `workersHandler`                    | wraps a Workers fetch handler                              |

`expressMiddleware` and `fastifyPlugin` are also re-exported from `@avsbhq/node`, so a project with one dependency still gets them. They are the same functions, not copies.

`getRequestClient()` returns the full bound client (`getFlag`, the typed getters, `getAllFlags`, `track`), or `null` outside a request scope. Return `undefined` from `contextFrom` to skip AvsB for a request entirely.

---

## 14. OpenFeature provider

```ts
import { AvsbProvider } from '@avsbhq/utils/openfeature';
import { OpenFeature } from '@openfeature/server-sdk';
import { AvsbServer } from '@avsbhq/node';

const server = new AvsbServer({ sdkKey: process.env.AVSB_SDK_KEY! });
await server.onReady();

OpenFeature.setProvider(new AvsbProvider(server));

const ofClient = OpenFeature.getClient();
const enabled = await ofClient.getBooleanValue('checkout_v2', false, { targetingKey: 'u_123' });
```

Browser variant (`@openfeature/web-sdk`):

```ts
import { AvsbWebProvider } from '@avsbhq/utils/openfeature';
import { OpenFeature } from '@openfeature/web-sdk';
import { AvsbClient } from '@avsbhq/browser';

const avsbClient = new AvsbClient({ sdkKey: '...', context: { kind: 'user', key: 'u_1' } });
OpenFeature.setProvider(new AvsbWebProvider(avsbClient));

// Rebinds the client's identity, so every read after it answers for u_2.
await OpenFeature.setContext({ targetingKey: 'u_2', plan: 'pro' });
```

Both providers route each typed resolver through the matching typed getter, so the type the platform declares for a flag is checked at read time: `getBooleanValue` on a flag configured as JSON returns your default with `reason: 'ERROR'` and `errorCode: 'FLAG_NOT_FOUND'`, rather than the object mislabelled as a boolean. A missing flag reports the same pair, and a read before the SDK is ready reports `PROVIDER_NOT_READY`; `errorMessage` says which case it was. Every other source maps to `Flag.source` upper-cased (`RULE`, `HOLDOUT`, `BANDIT`, `STICKY`, `DEFAULT`, `DISABLED`).

---

## 15. Storage adapters

Unified storage interface covering both sticky bucketing and datafile caching:

```ts
import {
  createMemoryAdapter,
  createRedisAdapter,
  createLocalStorageAdapter,
  createIndexedDBAdapter,
  createCookieAdapter,
  createDynamoDBAdapter,
  createPostgresAdapter,
  createDurableObjectAdapter,
} from '@avsbhq/utils';
import type { DynamoDBClientLike, DurableObjectStubLike } from '@avsbhq/utils';
import { createClient } from 'redis';

declare const dynamoClient: DynamoDBClientLike;
declare const env: { AVSB_DO: DurableObjectStubLike }; // your Worker bindings

// Redis (recommended for server-side, multi-process)
const redis = createClient({ url: process.env.REDIS_URL });
const adapter = createRedisAdapter({ client: redis, prefix: 'avsb:', datafileTtlMs: 60_000 });

// DynamoDB
const adapter2 = createDynamoDBAdapter({ client: dynamoClient, tableName: 'avsb-storage' });

// Cloudflare Durable Objects
const adapter3 = createDurableObjectAdapter({ stub: env.AVSB_DO });
```

Sticky-bucket services (separate from the storage adapters above) for DynamoDB, Postgres, and Durable Objects: `createDynamoDBStickyBucketService`, `createPostgresStickyBucketService`, `createDurableObjectStickyBucketService`.

BIG-SEGMENT STORES WERE REMOVED. `createRedisBigSegmentStore` and `createDynamoDBBigSegmentStore` shipped here for a release, but nothing evaluated big segments in any SDK: the datafile carried no membership, no audience condition branched on one, and no client ever held a store. Rather than keep two modules that could not affect a decision, they were deleted. The feature needs platform design (datafile shape, membership sync, an evaluator branch) and will arrive as its own thing.

---

## 16. Zero-dependency subpaths

Two primitives ship as their own leaf subpaths so any runtime, including a browser bundle, can import them without pulling the root chunk:

```ts
import {
  nextBackoff,
  resetBackoff,
  parseRetryAfter,
  jitteredInterval,
} from '@avsbhq/utils/backoff';
import { validateSdkKeyShape, describeSdkKey } from '@avsbhq/utils/sdkKey';
```

- **`/backoff`** is THE retry curve for the SDK family: 1s, 2s, 4s, 8s, 16s, 32s, 60s capped, each with plus or minus 20% jitter, honouring a server `Retry-After`. It used to exist three times (node, browser, and inlined in this package's streaming client), which is three chances for a thundering herd to come back in one runtime after being fixed in another. `jitteredInterval(baseMs, fraction?)` is the fixed-interval variant the polling loops use.
- **`/sdkKey`** is the key-shape check every SDK runs at construction, so the browser and the server say exactly the same thing about exactly the same key. It never throws: it returns `{ valid, message }` and the caller logs.

---

## 17. Track helpers

```ts
import { Transaction, itemOf } from '@avsbhq/utils';

// Batch multiple events
client.utils.trackBatch([
  { eventKey: 'page_viewed', payload: { value: 1 } },
  { eventKey: 'product_clicked', payload: { properties: { sku: 'A' } } },
]);

// Deduplicated tracking (event fires at most once per dedupKey per session)
client.utils.trackOnce('onboarding_complete', 'user-onboarding');

// Transaction helper (carries items, order id, and currency into one payload)
const tx = new Transaction({
  orderId: 'order_1001',
  revenue: 248.0,
  currency: 'USD',
  items: [
    itemOf({ id: 'PRO_ANNUAL', price: 199.0, quantity: 1 }),
    itemOf({ id: 'SUPPORT_ADDON', price: 49.0, quantity: 1 }),
  ],
});
client.utils.trackTransaction('purchase', tx); // fires 'purchase' with value=248.0
```

---

## 18. Cleanup registry

```ts
import { createRegistry } from '@avsbhq/utils';

const registry = createRegistry();

const timer = setInterval(() => console.log('polling metrics'), 5000);
registry.add(() => clearInterval(timer));

const sub = client.on('flagChange', ({ flagKey }) => console.log('changed', flagKey));
registry.add(sub); // sub() is the unsubscribe function

// On shutdown:
registry.drain(); // calls all registered teardown functions in reverse order
```

---

## 19. Migration

### From LaunchDarkly client utilities

| LaunchDarkly                  | `@avsbhq/utils`                                 |
| ----------------------------- | ----------------------------------------------- |
| `LDClient.on('change', cb)`   | `client.utils.onFlagChange(key, cb)`            |
| `LDClient.allFlagsState(ctx)` | `client.utils.snapshot()`                       |
| Custom OpenFeature provider   | `AvsbProvider` from `@avsbhq/utils/openfeature` |
| `LDRedisFeatureStore`         | `createRedisAdapter(...)` (storage adapter)     |

### From Statsig diagnostics / utils

| Statsig                  | `@avsbhq/utils`                              |
| ------------------------ | -------------------------------------------- |
| `StatsigLocalOverrides`  | `createMockClient` from `@avsbhq/test`       |
| `EvaluationsDataAdapter` | `UnifiedStorageAdapter` from `@avsbhq/utils` |
| `StatsigUser` extension  | `defineContextSchema(...)` with Zod schema   |
| `Statsig.flush()`        | `client.flush()` / `recorder.flush()`        |
