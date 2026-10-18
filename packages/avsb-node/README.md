# @avsbhq/node

Node.js server SDK for [A vs B](https://app.avsb.cloud).

Evaluate feature flags, bucket users consistently, and track conversions on the server. Includes Express and Fastify middleware, real-time datafile streaming over SSE (on by default), pluggable sticky bucketing (in-memory and Redis), multi-context evaluation, and per-request decision logs.

---

## 1. Install

```bash
npm install @avsbhq/node
```

Requires Node.js 18 or later. No mandatory peer dependencies.

Install `@avsbhq/utils` as well for the other framework adapters (Hono, Koa, Next, Lambda, Cloudflare Workers), the OpenFeature provider, and the warehouse decision sinks.

---

## 2. Quickstart

```ts
import { AvsbServer } from '@avsbhq/node';

const server = new AvsbServer({ sdkKey: process.env.AVSB_SDK_KEY! });

const result = await server.onReady();
if (!result.success) {
  // Flags serve the defaults you pass until a datafile arrives, and polling
  // continues in the background. Survivable, not fatal.
  console.error('AvsB init failed', result.error);
}

// Bind the context once per request.
const user = server.forUser({ kind: 'user', key: 'u_123', plan: 'pro' });

const flag = user.getBoolFlag('new_checkout_flow', false);
const checkoutTemplate = flag.isEnabled() ? 'checkout_v2' : 'checkout_v1';

user.track('checkout_started', { revenue: 99.0 });
```

Construct `AvsbServer` once at boot. It holds the datafile in memory, refreshes over SSE when the environment publishes, and falls back to polling when streaming is unavailable.

---

## 3. Constructor options

Every type named on this page is exported by the package, so the shapes below (and your own declarations) can import them:

```ts
import type {
  DecideOption,
  DecisionLog,
  EvalContext,
  EvaluationSource,
  Flag,
  FlagDatafile,
  GetAllFlagsOptions,
  Logger,
  ServerGetFlagOptions,
  StickyBucketService,
} from '@avsbhq/node';
```

```ts
interface AvsbServerOptions {
  /** `sdk_<environment>_<id>`, e.g. sdk_production_ttqm0eaj4vth1krcb2xn. */
  sdkKey: string;
  /** Polling interval in ms. Default 60_000. Clamped to a 5_000 minimum, jittered. */
  pollingInterval?: number;
  /** Datafile CDN host. Default 'https://cdn.avsb.cloud'. */
  cdnHost?: string;
  /** Max ms onReady() waits for the first datafile. Default 10_000. */
  initTimeout?: number;
  /** A datafile you already have, so onReady() resolves with no network call. */
  bootstrap?: FlagDatafile;
  /** SSE datafile updates. Default TRUE on the server. */
  streaming?: boolean;
  /** Stream ticket endpoint. Overrides the datafile's own `streamEndpoint`. */
  streamingEndpoint?: string;
  /** Event tracker tuning. */
  events?: EventOptions;
  /** Sticky bucketing store. */
  stickyBucketService?: StickyBucketService;
  /** Your logger. Default: console at warn level outside production. */
  logger?: Logger;
  /** Shorthand for the default logger's level. 'silent' restores no output. */
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

interface EventOptions {
  /** Ms between automatic flushes. Default 2000. */
  flushInterval?: number;
  /** Max events per request. Default 10. */
  batchSize?: number;
  /** Queue cap; oldest dropped with a warning. Default 10_000. */
  maxQueueSize?: number;
  /** Retry attempts per failed flush. Default 3. */
  retryAttempts?: number;
}
```

### SDK keys

Copy the key for the environment you want from app.avsb.cloud, then Environments in the project sidebar. The format is `sdk_<environment>_<id>`.

```bash
AVSB_SDK_KEY=sdk_production_ttqm0eaj4vth1krcb2xn
```

The shape is checked at construction. A key that does not look like one is logged with what looked wrong and where the real key lives; the SDK carries on with the value you passed, because the datafile request is the real arbiter.

Keep the key in environment variables. The SDK reads it once, at construction, so moving an environment to a new key means setting the new value and restarting the process (or constructing a new client and closing the old one).

---

## 4. Identity

The server holds no context of its own: you supply it per request. The examples below read a request object shaped like this, whatever your framework calls it:

```ts
interface AppRequest {
  user: { id: string; plan: string; country: string };
  org: { id: string; tier: string };
}

declare const req: AppRequest;
```

### `forUser(context)`, the primary pattern

```ts
const user = server.forUser({
  kind: 'user',
  key: req.user.id,
  plan: req.user.plan,
  country: req.user.country,
});

const flag = user.getBoolFlag('checkout_v2', false);
user.track('page_viewed');
```

`createUserContext(context)` is an alias for the same thing. The returned `UserBoundClient` carries its own decision log and its own forced decisions.

### Per-call context

Context is the THIRD POSITIONAL argument on every evaluation call, matching `@avsbhq/edge`:

```ts
const flag = server.getBoolFlag('checkout_v2', false, {
  kind: 'user',
  key: 'u_123',
  plan: 'pro',
});
```

Calling without a context returns your default with `source: 'not_ready'` and warns once, naming `forUser`. There is nobody to evaluate for.

### Multi-context

```ts
const user = server.forUser({
  kind: 'multi',
  user: { kind: 'user', key: req.user.id, plan: req.user.plan },
  organization: { kind: 'organization', key: req.org.id, tier: req.org.tier },
});
// A rule can target organization.tier while bucketing on user.key.
```

### Commerce targeting attributes

Audiences built with the commerce condition types (cart value, products viewed, purchase history) read fixed attribute names off the context:

```ts
const flag = server.getBoolFlag('big_cart_banner', false, {
  kind: 'user',
  key: 'u_123',
  cartValue: 120.5, // decimal MAJOR units of the project currency
  viewedSkus: ['SKU-1', 'SKU-2'], // "products viewed" matching on SKU
  viewedCategories: ['trainers'], // "products viewed" matching on category
  purchaseHistory: {
    // PurchaseHistoryAttribute, exported for you
    hasPurchased: true,
    lastPurchaseAt: 1765500000000, // epoch milliseconds (optional)
    lifetimeSpend: 540.0, // decimal MAJOR units (optional)
    orderCount: 7, // optional
  },
});
```

- **All money is decimal major units.** Condition values are stored in minor units and converted with the project currency exponent from the datafile (default 2); you never pass minor units.
- **Missing or mistyped attributes evaluate to `false`.** A completely absent `purchaseHistory` makes every purchase-history operator false, including `has_not_purchased`. On the server, absence means "not provided", not "never purchased". This deliberately differs from the browser snippet, where a profile miss is authoritative.
- **Dataset-backed "products viewed" conditions evaluate `false` on the server.** Dataset view windows live in the browser; server callers pass literal SKU or category lists.

### `alias(previousContext, newContext): void`

Marks the moment a signup or login claimed an anonymous session. Synchronous.

```ts
const anonymousId = 'anon_7f3c9d2b'; // the key you evaluated with before login
const signedInId = 'u_123'; // the key you evaluate with from now on

server.alias({ kind: 'user', key: anonymousId }, { kind: 'user', key: signedInId });
```

What it does: queues one `avsb_alias` event for the new identity.

What it does NOT do, precisely: it does not rewrite sticky assignments, move past exposures, or store the previous key (the conversion wire carries no properties column, so a retroactive session join is not available yet). To keep one visitor's bucketing across a login, evaluate with the SAME context key on both sides.

### Sharing identity with the web snippet

To measure one metric across the A vs B web snippet and this SDK, the context `key` must equal the snippet's visitor id: the `_avsb_visitor` cookie UUID that `avsb.getVisitorId()` returns. Results join on raw id equality, so a different key means the two surfaces never line up. Forward the snippet id from the browser and use it as the key here. Full guide: [Shared Visitor Identity](https://avsb.cloud/docs/developer-reference/shared-visitor-identity).

---

## 5. Reading flags

### Signatures

```ts
getFlag<T>(flagKey: string, defaultValue: T, context?: EvalContext, options?: ServerGetFlagOptions): Flag<T>
getBoolFlag(flagKey: string, defaultValue: boolean, context?: EvalContext, options?: ServerGetFlagOptions): Flag<boolean>
getStringFlag(flagKey: string, defaultValue: string, context?: EvalContext, options?: ServerGetFlagOptions): Flag<string>
getNumberFlag(flagKey: string, defaultValue: number, context?: EvalContext, options?: ServerGetFlagOptions): Flag<number>
getJsonFlag<T>(flagKey: string, defaultValue: T, context?: EvalContext, options?: ServerGetFlagOptions): Flag<T>
getAllFlags(context?: EvalContext, options?: GetAllFlagsOptions): Record<string, Flag>
```

The two options bags those signatures name:

```ts
interface ServerGetFlagOptions {
  decideOptions?: DecideOption[];
  decisionLog?: DecisionLog;
}

interface GetAllFlagsOptions {
  /** Record an exposure per flag. Default FALSE. */
  fireExposures?: boolean;
  decideOptions?: DecideOption[];
  decisionLog?: DecisionLog;
}
```

On a `UserBoundClient` the context is already bound, so the same calls read `getBoolFlag(key, default, options?)`.

One deliberate difference from `@avsbhq/browser`: there, `getAllFlags` takes an options bag (`getAllFlags({ context })`) because the browser client is context-bound and the bag disambiguates its optional arguments; here the context is the first positional argument, matching every other server evaluation call.

Typed getters check the value against the flag's declared type in the datafile. On a mismatch they log a warning naming both types and return YOUR default; they never throw and never coerce.

### The `Flag<T>` object

```ts
interface Flag<T = unknown> {
  readonly value: T;
  readonly variationKey: string | null;
  readonly source: EvaluationSource;
  readonly ruleId: string | null;
  readonly ruleType: 'targeted_delivery' | 'ab_test' | 'holdout' | 'bandit' | null;
  readonly reasons: string[];
  readonly evaluatedAt: number;
  readonly durationMicros: number;
  isEnabled(): boolean;
  exists(): boolean;
}
```

`isEnabled()` is true only when a REAL decision produced a truthy value: sources `rule`, `holdout`, `bandit`, `runtimeOverride`, `datafileOverride`, `sticky`. It is always false for `default`, `not_found`, `disabled`, and `not_ready`.

`exists()` answers "is this key in the datafile": false for `not_found`, and false for `not_ready` because with no datafile the question is unanswerable.

| `source`           | Meaning                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `datafileOverride` | A per-user override configured in the dashboard matched.                       |
| `runtimeOverride`  | `setOverrideForUser`, `setGlobalOverride`, or a forced decision matched.       |
| `sticky`           | A stored assignment was reused.                                                |
| `rule`             | A targeting or A/B rule matched.                                               |
| `holdout`          | The context is held out; the holdout variation was served.                     |
| `bandit`           | A bandit rule picked the variation.                                            |
| `default`          | The flag exists, nothing matched, its default variation was served.            |
| `disabled`         | The flag exists but is off in this environment.                                |
| `not_found`        | The datafile loaded and has no such key. Check the key name.                   |
| `not_ready`        | No datafile yet, or no context passed. Await `onReady()`, or pass `bootstrap`. |

### `DecideOption`

```ts
import { DecideOption } from '@avsbhq/node';

user.getBoolFlag('checkout_v2', false, {
  decideOptions: [DecideOption.DISABLE_EXPOSURE],
});
```

Two members, both accepted:

- `DISABLE_EXPOSURE` evaluates without recording an exposure. Use it for admin panels, previews, and bulk reads.
- `INCLUDE_REASONS` asks for reason strings. This SDK collects reasons unconditionally, so passing it changes nothing here; it is real in the per-language SDKs that gate reason collection behind it.

Anything else warns once with the accepted list. `EXCLUDE_VARIABLES`, `IGNORE_STICKY_BUCKET`, and `ENABLED_FLAGS_ONLY` were deleted: no evaluator in any language implemented them.

### `getAllFlags`

```ts
const all = server.getAllFlags({ kind: 'user', key: 'u_123' });
// Exposures are suppressed by default. Pass { fireExposures: true } to record them.
```

Called without a context, or before the datafile loads, it returns `{}` AND warns, because an empty map is otherwise indistinguishable from a project with no flags.

### Overrides, for QA and testing

```ts
server.setOverrideForUser('checkout_v2', 'u_qa', 'on');
server.setOverrideForUser('checkout_v2', 'acme', 'on', 'organization'); // explicit kind
server.setGlobalOverride('checkout_v2', 'on');

server.clearOverrideForUser('checkout_v2', 'u_qa');
server.clearGlobalOverride('checkout_v2');
server.clearAllOverrides();
```

Per-request forced decisions, which never touch the shared state above:

```ts
const user = server.forUser({ kind: 'user', key: 'u_qa' });
user.setForcedDecision('checkout_v2', { variationKey: 'on' });
user.clearForcedDecision('checkout_v2');
```

---

## 6. Tracking

```ts
// Bound client: context implied.
user.track('purchase_completed', { revenue: 199.0 }); // money
user.track('items_added', { value: 3 }); // a quantity
user.track('signup_completed'); // a count

// Server directly: context in the payload.
server.track('purchase_completed', {
  revenue: 199.0,
  context: { kind: 'user', key: 'u_123' },
});
```

`TrackPayload` carries two numbers, and they are two columns end to end:

| Field     | Meaning                                                                 | Storage column          |
| --------- | ----------------------------------------------------------------------- | ----------------------- |
| `revenue` | Money in decimal MAJOR units of the project currency (49.99, not 4999). | `metric_events.revenue` |
| `value`   | Numeric metric value for average-value metrics: items, seats, seconds.  | `metric_events.value`   |

One conversion can carry money, a quantity, or both. Earlier releases mapped `value` into the revenue column and could never write the value column, so a quantity was recorded as money and every average-value metric read empty.

`track` is synchronous: it queues the event and the tracker batches it. Events tracked before the datafile arrives are QUEUED (bounded by `events.maxQueueSize`) and sent once it does.

`payload.properties` is accepted by the shared type but NOT stored for conversions: the ingestion contract for a metric event keeps the event name, the two numbers, the timestamp, and the visitor id. The SDK warns once and drops them rather than pretending. Exposure events do carry properties.

### Purchases

```ts
await server.trackPurchase('u_123', {
  orderId: 'order_1001',
  total: 199.0,
  currency: 'USD',
  items: [{ sku: 'PRO_ANNUAL', price: 199.0, quantity: 1 }],
});

// Or from a bound client, attributed to its context key:
await user.trackPurchase({ orderId: 'order_1001', total: 199.0 });
```

Purchases are queued before ready exactly like `track`. They used to be dropped with a warning while `track` queued.

### Manual exposure

```ts
const flag = user.getBoolFlag('checkout_v2', false, {
  decideOptions: [DecideOption.DISABLE_EXPOSURE],
});

// Later, at the point the visitor actually sees the variation:
user.manualExposure('checkout_v2');
```

---

## 7. Errors, logging, and events

### Logger

The default is a console logger at WARN level when `NODE_ENV` is neither `production` nor `test`, and a noop otherwise. A wrong SDK key is loud in development and silent in production logs.

```ts
import { AvsbServer, createLogger } from '@avsbhq/node';
import pino from 'pino';
import { createPinoTransport } from '@avsbhq/utils/log/pino';

const server = new AvsbServer({
  sdkKey: process.env.AVSB_SDK_KEY!,
  logger: createLogger({
    level: 'info',
    transports: [createPinoTransport({ logger: pino(), level: 'info' })],
  }),
});

// Or just turn the volume down:
new AvsbServer({ sdkKey: process.env.AVSB_SDK_KEY!, logLevel: 'silent' });
```

### `onReady()`

```ts
interface InitResult {
  success: boolean;
  source: 'network' | 'bootstrap' | 'timeout' | 'error';
  error?: Error;
  /** Serving stale-but-real values after a failed refresh. Not set by this SDK today. */
  degraded?: boolean;
}

const result = await server.onReady();
if (!result.success) {
  // result.source is 'timeout' or 'error'; result.error says which.
}
```

`onReady()` never rejects and returns the same promise on repeated calls. `isReady()` answers "are flags readable right now" synchronously.

### Events

```ts
server.on('ready', () => {});
server.on('configUpdate', ({ publishedAt, reason }) => {
  // reason: 'poll' | 'stream' | 'manual'
});
server.on('evaluation', ({ flagKey, flag, contextKeys }) => {});
server.on('exposure', (event) => {
  // Same eventId the ingestion pipeline receives, so your own analytics rows
  // reconcile with A vs B results.
});
server.on('error', (error) => {});
server.on('stickyOrphan', ({ flagKey, userId, assignment }) => {});

// on() returns the unsubscribe:
const unsubscribe = server.on('error', (error) => console.error(error));
unsubscribe();
```

The payloads are the shared `ClientEventMap` shapes, so a listener written against `@avsbhq/browser` reads the same fields here. The server does not emit `flagChange`: it holds one datafile for the process and does not diff individual flags. Subscribing to it through `client.utils` warns and hands back a no-op disposer.

---

## 8. Heartbeat and SDK health

The SDK reports liveness to the endpoint the datafile publishes
(`heartbeatEndpoint`), so the dashboard can show whether an environment is
actually being served.

- **What it posts**: `{ sdkKey, sdkType, sdkVersion }`, nothing else. No flag
  values, no context, no counts.
- **When**: on every successful datafile REQUEST (init, poll, stream-triggered
  refresh, and `refreshDatafile()`), throttled to at most one every 2 minutes.
  A `304 Not Modified` counts: the SDK sends a conditional request once it has
  an ETag, so an unchanged datafile answers 304 on every poll, and that is
  exactly the steady state of a healthy process.
- **Fire and forget**: a failed heartbeat is dropped, never retried, and never
  affects evaluation.
- **Where it shows up**: Environments in the project sidebar, in the dashboard. Each
  environment shows Connected, Stale, or Not connected, plus the `sdkType` and
  `sdkVersion` that last reported, which is how you see "production is running
  @avsbhq/node 1.8.0". An environment goes Stale after five minutes without a
  heartbeat.
- **Turning it off**: publish a datafile with no `heartbeatEndpoint`. The SDK
  never guesses a host, so an absent field simply means no heartbeats.

---

## 9. Streaming

Streaming is ON by default. The endpoint comes from the datafile's `streamEndpoint` field, which the publisher controls, so a self-hosted or proxied deployment needs no client-side configuration.

```ts
const sdkKey = process.env.AVSB_SDK_KEY!;
const streamingEndpoint = 'https://stream.avsb.cloud/v1/ticket';

new AvsbServer({ sdkKey }); // streaming on, endpoint from the datafile
new AvsbServer({ sdkKey, streaming: false }); // polling only
new AvsbServer({ sdkKey, streamingEndpoint }); // explicit endpoint wins
```

If no endpoint is available, or the stream drops, the SDK keeps polling and logs the reason at debug level. Nothing is guessed from another host: pointing a reconnect loop at DNS that does not resolve is the failure mode this design exists to prevent.

---

## 10. Bootstrap and serverless cold starts

```ts
import type { BootstrapBlob } from '@avsbhq/utils';

// You already have the datafile (KV, a file, a cache), and a blob from a
// server that called serializeBootstrap.
declare const cachedDatafile: FlagDatafile;
declare const blob: BootstrapBlob;

const server = new AvsbServer({ sdkKey, bootstrap: cachedDatafile });
// onReady() resolves immediately with source: 'bootstrap'.

// Or hand it over after construction:
server.applyDatafileBootstrap(cachedDatafile);

// Same thing through the bootstrap blob helpers:
server.utils.hydrateBootstrap(blob); // blob must carry `datafile`
```

`hydrateBootstrap` THROWS on a blob that carries only a pre-evaluated snapshot: a snapshot belongs to one context, and a server evaluates a different context per request, so adopting one process-wide would serve one user's values to another. Serialize with `{ includeDatafile: true }`, or pass `bootstrap: blob.datafile`.

### Fresh snapshots

```ts
const ctx = { kind: 'user', key: 'user-123' };

const snap = server.utils.snapshot(ctx); // values in memory, no network call
const fresh = await server.utils.snapshotFresh(ctx); // fetches the datafile first
```

`snapshotFresh` and `refreshAndSnapshot` call `refreshDatafile()` before they read, so the snapshot reflects the flags published right now. A failed fetch keeps the datafile already in memory, logs a warning, and the snapshot shows that datafile. Before 1.9.0 both helpers skipped the fetch and returned the in-memory values.

For Next.js SSR see `@avsbhq/next`.

---

## 11. Shutdown

```ts
process.on('SIGTERM', async () => {
  await server.close();
  process.exit(0);
});

await server.flush(); // drain queued events without tearing down
```

`close()` aborts in-flight fetches, disconnects the stream, stops polling, and drains the event queue.

---

## 12. Verifying inbound webhooks

AvsB signs every outbound webhook delivery with HMAC-SHA256 over `deliveryId + "." + timestamp + "." + rawBody` (the Standard Webhooks scheme). `verifyWebhookSignature` checks it against the **raw** body bytes, enforces a replay window, and compares digests in constant time.

```ts
// docs-example: not typechecked here, because express is not a dependency of the A vs B repository, so its Request and Response types cannot be resolved for the route handler

import express from 'express';
import { verifyWebhookSignature } from '@avsbhq/node';

const app = express();

async function handleEvent(deliveryId: string, event: unknown): Promise<void> {
  // your own idempotent processing, keyed on deliveryId
}

// express.raw(), NOT express.json(): parsing and re-serialising the body changes
// its bytes, and the signature is over the bytes we sent.
app.post('/avsb-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const result = verifyWebhookSignature(req.body, req.headers, process.env.AVSB_WEBHOOK_SECRET!);
  if (!result.ok) {
    // 'missing_headers' | 'malformed_signature' | 'malformed_timestamp'
    // | 'timestamp_out_of_tolerance' | 'signature_mismatch'
    return res.status(401).send(result.reason);
  }

  const event = JSON.parse(req.body.toString('utf8'));
  void handleEvent(result.deliveryId, event); // retries reuse the id: dedupe on it
  res.sendStatus(200);
});
```

| Option             | Default    | Notes                                                                                                             |
| ------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `toleranceSeconds` | `300`      | Reject deliveries signed more than this long ago (or ahead, so clock skew is caught). `0` disables the age check. |
| `now`              | `Date.now` | Injectable clock, for tests.                                                                                      |

Works with Node's `req.headers`, a plain object with any casing, or anything exposing `get(name)` (a `Headers` instance, a Next.js `Request`).

---

## 13. Testing

```ts
import { createMockServer, flagsFromTestData, TestData } from '@avsbhq/test';

const server = createMockServer(
  flagsFromTestData([
    TestData.flag('checkout_v2')
      .booleanFlag()
      .variationForUser('u_paying', true)
      .fallthroughVariation(false)
      .build(),
  ]),
);

const user = server.forUser({ kind: 'user', key: 'u_paying' });
expect(user.getBoolFlag('checkout_v2', false).value).toBe(true);
expect(server._evaluations()).toHaveLength(1);
```

`createMockServer` mirrors this SDK's surface, `forUser` included. `createMockClient` mirrors the browser client. Both read the same fixture through `flagsFromTestData`.

---

## 14. Framework integrations

### Express

```ts
import express from 'express';
import { AvsbServer, expressMiddleware } from '@avsbhq/node';
import { getRequestClient } from '@avsbhq/utils';

const avsb = new AvsbServer({ sdkKey: process.env.AVSB_SDK_KEY! });
await avsb.onReady();

const app = express();
app.use(
  expressMiddleware(avsb, {
    // The middleware reads the request structurally, so narrow it to whatever
    // your auth layer put there.
    contextFrom: (req) => {
      const authed = req.user as { id?: string; plan?: string } | undefined;
      return { kind: 'user', key: authed?.id ?? 'anon', plan: authed?.plan };
    },
  }),
);

// Deep inside a service, with no `req` in scope:
function pricingService() {
  return getRequestClient()?.getBoolFlag('new_pricing', false).value ?? false;
}
```

Every route then reads flags off `req.avsb`:

```ts
// docs-example: not typechecked here, because express is not a dependency of the A vs B repository, so a route handler's Request and Response types cannot be resolved

app.get('/checkout', (req, res) => {
  const flag = req.avsb.getBoolFlag('new_checkout_flow', false);
  res.render(flag.isEnabled() ? 'checkout_v2' : 'checkout_v1');
});
```

Return `undefined` from `contextFrom` to skip AvsB for that request.

`expressMiddleware` and `fastifyPlugin` ARE the implementations from `@avsbhq/utils/middleware/*`, re-exported here so one dependency is enough. There is exactly one signature for each; this package used to ship a second, incompatible `expressMiddleware(client, { userIdFrom })`.

Type `req.avsb` in your own project (four lines, once):

```ts
// src/types/express.d.ts
import type { UserBoundClient } from '@avsbhq/node';

declare global {
  namespace Express {
    interface Request {
      avsb: UserBoundClient;
    }
  }
}
```

### Fastify

```ts
// docs-example: not typechecked here, because fastify is not a dependency of the A vs B repository, so neither the instance nor its route handler types can be resolved

import Fastify from 'fastify';
import { AvsbServer, fastifyPlugin } from '@avsbhq/node';

const avsb = new AvsbServer({ sdkKey: process.env.AVSB_SDK_KEY! });
await avsb.onReady();

const app = Fastify();
await app.register(fastifyPlugin, {
  server: avsb,
  contextFrom: (req) => ({ kind: 'user', key: req.headers['x-user-id'] as string }),
});

app.get('/features', (req, reply) => {
  reply.send({ enabled: req.avsb.getBoolFlag('new_feature', false).isEnabled() });
});
```

### Other frameworks

Hono, Koa, Next (app and pages), Lambda, and Cloudflare Workers adapters live in `@avsbhq/utils/middleware/*`: `honoMiddleware`, `koaMiddleware`, `nextAppHandler`, `nextPagesApi`, `lambdaHandler`, `workersHandler`. All open the same AsyncLocalStorage scope, so `getRequestClient()` works under every one of them.

### Sticky bucketing

Keep users in the same variation across rule changes. Sticky lookup runs BEFORE the engine, so a stored assignment survives a rollout edit.

```ts
import { createClient } from 'redis';
import { InMemoryStickyBucketService, RedisStickyBucketService } from '@avsbhq/node';

// Single process:
new AvsbServer({ sdkKey, stickyBucketService: new InMemoryStickyBucketService() });

// Multi-process, multi-region:
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();
new AvsbServer({
  sdkKey,
  stickyBucketService: new RedisStickyBucketService({ redis, prefix: 'avsb:sticky:' }),
});
```

The Redis service keeps evaluation synchronous: a lookup is a cache hit or null, with a background fill, so the first lookup per process misses by design. DynamoDB, Postgres, and Durable Object services live in `@avsbhq/utils`.

### Decision logs

```ts
const user = server.forUser({ kind: 'user', key: 'u_123' });
user.getBoolFlag('checkout_v2', false);

const entries = user.getDecisionLog().entries;
// [{ flagKey, value, variationKey, source, ruleId, ruleType, reasons,
//    evaluatedAt, durationMicros, contextSummary }]
```

Redaction is real: any attribute named in `_meta.privateAttributes` has its VALUE replaced with `[REDACTED]` wherever it appears in a logged value or a reason string. Values shorter than two characters are matched exactly rather than as substrings, because a one-character value cannot be told apart from ordinary text.

```ts
server.forUser({
  kind: 'user',
  key: 'u_123',
  email: 'ada@example.com',
  _meta: { privateAttributes: ['email'] },
});
```

---

## 15. Migration

### From LaunchDarkly Node

| LaunchDarkly Node                                 | `@avsbhq/node`                                               |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `init(sdkKey, options)`                           | `new AvsbServer({ sdkKey })`                                 |
| `client.waitForInitialization()`                  | `await server.onReady()`                                     |
| `client.variation('key', context, default)`       | `server.forUser(ctx).getBoolFlag('key', default).value`      |
| `client.variationDetail('key', context, default)` | `server.forUser(ctx).getFlag('key', default)`                |
| `client.track('event', context, { metricValue })` | `server.forUser(ctx).track('event', { value })`              |
| `client.identify(context)`                        | not applicable (the server is stateless); use `forUser(ctx)` |
| `client.allFlagsState(context)`                   | `server.getAllFlags(ctx)`                                    |
| `client.close()`                                  | `await server.close()`                                       |

Key differences: `getFlag` returns `Flag<T>`, not a raw value (`.value` for the primitive); `track` uses `value`, not `metricValue`; all evaluation is per-request via `forUser()`; multi-context is native.

### From Statsig Node

| Statsig Node                                               | `@avsbhq/node`                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `Statsig.initialize(serverSecret)`                         | `new AvsbServer({ sdkKey })`                                 |
| `Statsig.checkGate(user, 'gate')`                          | `server.forUser(ctx).getBoolFlag('gate', false).isEnabled()` |
| `Statsig.getExperiment(user, 'exp').get('param', default)` | `server.forUser(ctx).getFlag('exp', default).value`          |
| `Statsig.logEvent(user, 'event', value, metadata)`         | `server.forUser(ctx).track('event', { value })`              |
| `Statsig.flush()`                                          | `await server.flush()`                                       |

### From an earlier @avsbhq/node

| Was                                                                    | Now                                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `getFlag(key, default, { context })`                                   | `getFlag(key, default, context)`                                              |
| `getAllFlags(context, opts)`                                           | same call; `context` is now optional and warns when omitted                   |
| `expressMiddleware(client, { userIdFrom })`                            | `expressMiddleware(server, { contextFrom })`                                  |
| Pre-ready reads reported `not_found`                                   | they report `not_ready`                                                       |
| `evaluation` event `{ flagKey, value, userId, source }`                | `{ flagKey, flag, contextKeys }`                                              |
| `DecideOption` members beyond `DISABLE_EXPOSURE` and `INCLUDE_REASONS` | deleted; they were never implemented                                          |
| `streaming` defaulted to false                                         | defaults to true, with silent fallback to polling                             |
| `track(key, { value: 199.0 })` for money                               | `track(key, { revenue: 199.0 })`; `value` now means an average-value quantity |
| `server.alias(...)` documented but absent                              | implemented, synchronous, and documented for what it really does              |

---

## 16. Set this up with your AI assistant

Paste this into Claude Code, Cursor, or any coding assistant:

```text
Set up A vs B feature flags in this Node.js project.

1. Run: npx @avsbhq/cli init
   Use my saved CLI login: do not ask me for a token and do not put one in any file.
   It writes the SDK key into .env as AVSB_SDK_KEY and writes an example file.
2. Install @avsbhq/node with this project's package manager.
3. Construct AvsbServer once at boot with that key, await server.onReady(), and
   bind a context per request with server.forUser({ kind: 'user', key: userId }).
4. Every getter returns a Flag object, so read .value or call .isEnabled(), and
   always pass a fallback. Before the datafile arrives, reads return your fallback
   and flag.source is 'not_ready'.
5. Then run: npx @avsbhq/cli codegen

Done looks like: the process starts, the flag reads without throwing, and avsb
init prints the line confirming it saw the first check-in.
```

`avsb init` ends by waiting for your app's first check-in and printing what it
saw, so the terminal tells you it works rather than the dashboard.
