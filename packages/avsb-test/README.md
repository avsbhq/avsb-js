# @avsbhq/test

Test utilities for the [A vs B](https://app.avsb.cloud) SDKs.

A browser-shaped mock client, a server-shaped mock with `forUser`, a real offline client, a React test provider, a fluent flag builder, evaluation recorders, and fixture factories, so you can write deterministic tests without a live SDK connection.

Two ways to test, and the choice matters:

| Helper             | What it is                                   | Use it when                                                                                         |
| ------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `createTestClient` | a REAL `AvsbClient` over a fixture datafile  | you want the real evaluator, the real type checks, real `source` values and real exposure behaviour |
| `createMockClient` | a hand-driven stand-in with the same surface | you want to drive values directly, or assert on what your code asked for                            |

---

## 1. Install

```bash
npm install --save-dev @avsbhq/test
```

Works with vitest and jest. `@avsbhq/core` and `@avsbhq/browser` come with it (the browser client is what `createTestClient` returns). React is an optional peer, needed only for `@avsbhq/test/react`.

### Entry points

| Import from             | What it carries                                                                          | Needs React |
| ----------------------- | ---------------------------------------------------------------------------------------- | ----------- |
| `@avsbhq/test`          | the mocks, `TestData`, the recorders, `resolveTestClient`, and everything on `/fixtures` | no          |
| `@avsbhq/test/fixtures` | `createTestDatafile`, `createTestContext`, `createMultiTestContext`, `createTestClient`  | no          |
| `@avsbhq/test/react`    | `AvsbTestProvider`, `useAvsbTestClient`                                                  | yes         |
| `@avsbhq/test/vitest`   | `setupAvsbTest`                                                                          | no          |

The split is not a nicety. A root barrel that imports React does not RESOLVE when React is absent, so while `AvsbTestProvider` sat on the root, a Vue, Svelte, or plain-Node project could not import `createMockClient` at all and "React is an optional peer" was false. The root is now React-free and only `/react` reaches for it.

`/fixtures` exists for a different reason: `@avsbhq/vue/testing` and `@avsbhq/svelte/testing` re-export from it and bundle it at build time, so it has to stay free of the mocks as well as of React. Import from it directly when you want nothing else pulled in.

### Vitest lifecycle helper

```ts
import { setupAvsbTest } from '@avsbhq/test/vitest';

describe('checkout', () => {
  const { getClient } = setupAvsbTest({ flags: { 'checkout_v2': true } });

  it('reads the flag', () => {
    expect(getClient().getBoolFlag('checkout_v2', false).value).toBe(true);
  });
});
```

It registers `beforeEach`/`afterEach` for you: a fresh mock per test, closed afterwards.

### Jest

There is no jest preset. Earlier docs showed `{ preset: '@avsbhq/test/jest' }` and a vitest `plugins: [avsbPlugin()]` entry; neither existed, and the preset could not have worked (jest reads `module.exports`, and the preset named `ts-jest`, which this package does not depend on). The two real lines are:

```js
import { createMockClient } from '@avsbhq/test';

let client;
beforeEach(() => {
  client = createMockClient({ flags: { 'checkout_v2': true } });
});
```

---

## 2. Quickstart

```ts
import { createMockClient, flagsFromTestData, TestData } from '@avsbhq/test';

// 1. Describe the flag configuration.
const entry = TestData.flag('checkout_v2')
  .booleanFlag()
  .variationForUser('u_paying', true)
  .fallthroughVariation(false)
  .build();

// 2. Build the mock from it.
const client = createMockClient(flagsFromTestData([entry]));

// 3. Evaluate.
expect(client.getBoolFlag('checkout_v2', false).value).toBe(false);

client.identify({ kind: 'user', key: 'u_paying' });
expect(client.getBoolFlag('checkout_v2', false).value).toBe(true);
```

`flagsFromTestData(entries)` is the bridge. It returns exactly the options the mocks take:

The shapes quoted on this page name types from three places, all of them already on disk once this package is installed:

```ts
import type { MockClient, MockClientOptions, TestDataEntry } from '@avsbhq/test';
import type { AvsbClient } from '@avsbhq/browser';
import type { EvalContext, FlagDatafile, FlagDatafileEntry } from '@avsbhq/core';
import type { ReactNode } from 'react';
```

```ts
interface MockFlagState {
  /** flagKey to value: what every context gets unless overridden. */
  flags: Record<string, unknown>;
  /** `${flagKey}:${contextKey}` to value. Beats `flags`. */
  flagsByUser: Record<string, unknown>;
}

function flagsFromTestData(entries: readonly TestDataEntry[]): MockFlagState;
```

Earlier docs taught `createMockClient({ flags: [td.build()] })`: an ARRAY where a map belongs, which did not typecheck and evaluated to defaults at runtime. That is what this function replaces.

---

## 3. `createMockClient` (browser-shaped)

Mirrors `AvsbClient` from `@avsbhq/browser`: one bound context, `identify`, `subscribe`, `getSnapshot`.

```ts
const client = createMockClient({
  flags: { 'dark_mode': true, theme: 'midnight', 'max_results': 50 },
  flagsByUser: { 'checkout_v2:u_trial': false, 'checkout_v2:u_paid': true },
  context: { kind: 'user', key: 'u_1', plan: 'pro' },
  ready: true,
});
```

It implements the WHOLE client surface, not a convenient subset (including `utils`, `applySnapshot` and `onFlagChange`, checked against the real class by a test in this package), because the framework adapters type their injection seams against the real client. `@avsbhq/angular` is the strictest: `AvsbService` calls `isReady()`, `getInitResult()` and `on('ready')` in its constructor, so a mock missing one of those is a TypeError on injection, not a weaker mock.

| Group             | Methods                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle         | `onReady(options?)`, `isReady()`, `getInitResult()`, `refresh()`, `flush()`, `close()`                                            |
| Identity          | `identify(ctx)`, `updateAttributes(partial, kind?)`, `alias(previous, next)`, `getContext()`, `reset()`                           |
| Reading flags     | `getFlag`, `getBoolFlag`, `getStringFlag`, `getNumberFlag`, `getJsonFlag` (each taking `GetFlagOptions`), `getAllFlags(options?)` |
| Store contract    | `subscribe(flagKey, listener)`, `getSnapshot(flagKey, default)`                                                                   |
| Tracking          | `track(eventKey, payload?)`, `on(event, cb)`                                                                                      |
| Runtime overrides | `setOverrideForUser`, `setGlobalOverride`, `clearOverrideForUser`, `clearGlobalOverride`, `clearAllOverrides`                     |
| Bootstrap         | `applyDatafileBootstrap(datafile)`                                                                                                |

What the mock deliberately does NOT do, so you are not surprised:

- `fireExposure` and `decideOptions` on `GetFlagOptions` are accepted (the signature has to match) and are inert, because a mock has no exposure pipeline to suppress. Use `createTestClient` when exposure behaviour is what you are testing.
- `flush()` and `close()` have no transport to drain.
- `applyDatafileBootstrap` records the datafile and merges each flag's default variation value into the flags map. It does not evaluate rules; a real datafile with real rules belongs in `createTestClient`.
- Before it is ready, reads return `source: 'not_ready'`, never `not_found`, and record nothing.

Inspection helpers:

```ts
client._tracked(); // [{ eventKey, payload }]
client._evaluations(); // [{ flagKey, value, contextKey }]
client._setFlag('dark_mode', false); // notifies subscribers, emits flagChange
client._markReady({ success: true, source: 'network' });
client._datafile(); // what applyDatafileBootstrap was given, or null
client._refreshCount(); // how many times refresh() was called
```

### Injecting it into a framework

Angular takes it directly, because `MockClient` satisfies `AngularAvsbClient`:

```ts
import { TestBed } from '@angular/core/testing';
import { createMockClient } from '@avsbhq/test';
import { provideAvsb } from '@avsbhq/angular';

TestBed.configureTestingModule({
  providers: [provideAvsb({ client: createMockClient({ flags: { 'checkout_v2': true } }) })],
});
```

---

## 4. `createMockServer` (server-shaped)

Mirrors `AvsbServer` from `@avsbhq/node`: context passed per call or bound with `forUser`, `track` carrying its context, purchases.

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

// Inject it wherever your code takes an AvsbServer.
const user = server.forUser({ kind: 'user', key: 'u_paying' });
expect(user.getBoolFlag('checkout_v2', false).value).toBe(true);

user.track('purchase', { revenue: 99 });
await user.trackPurchase({ orderId: 'o_1', total: 99 });

expect(server._tracked()).toEqual([
  { eventKey: 'purchase', payload: { revenue: 99 }, contextKey: 'u_paying' },
]);
expect(server._purchases()).toHaveLength(1);
expect(user.getDecisionLog().entries).toHaveLength(1);
```

It answers the same fixture through the same resolver as `createMockClient`, so one fixture drives both. Reads without a context return `source: 'not_ready'`, exactly like the real server, and `createMockServer({ ready: false })` lets you test the pre-ready path.

It has the whole `AvsbServer` surface, so code that calls any public method works under the mock: `alias`, the five runtime override methods (`setOverrideForUser`, `setGlobalOverride`, `clearOverrideForUser`, `clearGlobalOverride`, `clearAllOverrides`), `on` and `off` (`ready`, `configUpdate`, `evaluation` fire), `refreshDatafile`, `applyDatafileBootstrap`, `getDatafile`, `createDecisionLog`, and the `utils`, `datasets` and `recs` properties. A test in this package compares the member names with the real class, so the two cannot drift apart.

`utils` is the real helper set, bound to the mock. `datasets` and `recs` answer from two more options:

```ts
const server = createMockServer({
  flags: { checkout_v2: true },
  datasets: { prices: { sku_1: { amount: 1999 } } }, // slug, then key, to value
  recs: { similar: [{ id: 'p1' }, { id: 'p2' }] }, // recipe to products
});

await server.datasets.get('prices', 'sku_1'); // { found: true, value: { amount: 1999 }, meta: { slug: 'prices', version: 1 } }
await server.recs.get({ recipe: 'similar', maxItems: 1 }); // { items: [{ id: 'p1' }], served: true, ... }
```

`forUser(ctx).setForcedDecision(flagKey, { variationKey })` serves that variation key for the request, with `source: 'runtimeOverride'`.

Inspection helpers: `_tracked()`, `_purchases()`, `_evaluations()`, `_exposures()` (manual exposures flagged), `_recClicks()`, `_refreshCount()`, `_setFlag()`, `_markReady()`.

`server.utils.snapshotFresh(ctx)` and `server.utils.refreshAndSnapshot(ctx)` go through the mock's `refreshDatafile`, exactly as they do on the real server since `@avsbhq/node` 1.9.0. Each call adds one to `_refreshCount()` and fires `configUpdate`, so a test can assert that a fresh snapshot really refreshed (new in 1.3.0; earlier versions skipped the refresh).

---

## 5. `TestData`: fluent flag builder

```ts
const boolFlag = TestData.flag('checkout_v2')
  .booleanFlag()
  .variationForUser('u_1', true) // per-user
  .variationForContext('organization', 'org_1', true) // per-context-kind
  .fallthroughVariation(false) // everyone else
  .build();

const strFlag = TestData.flag('theme')
  .stringFlag()
  .variationForUser('u_dark', 'midnight')
  .fallthroughVariation('light')
  .build();

const jsonFlag = TestData.flag('api_config')
  .jsonFlag()
  .fallthroughVariation({ timeout: 5000, retries: 3 })
  .build();

const client = createMockClient(flagsFromTestData([boolFlag, strFlag, jsonFlag]));
```

The mocks match a per-context override on the context KEY and do not compare kinds, so `variationForContext('organization', 'org_1', ...)` applies whenever the bound context carries the key `org_1`.

---

## 6. `AvsbTestProvider`: React component tests

It ships on `@avsbhq/test/react`, not on the root, so that the root stays importable without React.

```tsx
import { render, screen } from '@testing-library/react';
import { AvsbTestProvider } from '@avsbhq/test/react';

test('shows the new checkout when the flag is on', () => {
  render(
    <AvsbTestProvider flags={{ 'new_checkout_flow': true }}>
      <CheckoutButton />
    </AvsbTestProvider>,
  );
  expect(screen.getByRole('button')).toHaveTextContent('New checkout');
});
```

Props (breaking change B26). `flags`, `context` and `client` are the same three names the reference wrappers in `@avsbhq/vue`, `@avsbhq/svelte` and `@avsbhq/solid` use, so the shape is learned once:

```ts
interface AvsbTestProviderProps {
  /** Shorthand: flagKey to value. */
  flags?: Record<string, unknown>;
  /** The bound context. Default `{ kind: 'user', key: 'test-user' }`. */
  context?: EvalContext;
  /** A pre-built mock client. Wins over everything. */
  client?: MockClient;
  /** Full createMockClient options. Wins over `flags` and `context`. */
  options?: MockClientOptions;
  children: ReactNode;
}
```

Precedence: `client`, then `options`, then `flags` and `context` together, then an empty mock. Earlier docs showed `mockFlags`, which never existed. `resolveTestClient(props)` applies the same precedence rule in a wrapper of your own, and it lives on the ROOT entry because it touches no React.

This provider supplies THIS package's context, read by `useAvsbTestClient()`. To drive the real `@avsbhq/react` hooks, use `AvsbTestProvider` from `@avsbhq/react/testing`: it renders the real provider around a real client. This package cannot do that itself without depending on `@avsbhq/react`, which would point the dependency the wrong way.

---

## 7. `recordEvaluations`: assertion helpers

The assertions live on the recorder itself, not on `expect`. Nothing is registered
with your test runner, so they read the same under vitest, jest, or node:test, and
each one throws with a message naming what was actually recorded.

```ts
import { createMockClient, recordEvaluations } from '@avsbhq/test';

const client = createMockClient({
  flags: { 'checkout_v2': true },
  context: { kind: 'user', key: 'u_1' },
});
const recorder = recordEvaluations(client);

client.getBoolFlag('checkout_v2', false);
client.track('items_added', { value: 3 });

recorder.toHaveEvaluated('checkout_v2');
recorder.toHaveEvaluated('checkout_v2').withContext({ kind: 'user', key: 'u_1' }).withValue(true);

recorder.toHaveTracked('items_added').withValue(3);

// The raw rows, for anything the two matchers do not cover, including
// asserting that a flag was never read.
recorder.records; // [{ flagKey, value, contextKey }]
expect(recorder.records.some((r) => r.flagKey === 'unknown_flag')).toBe(false);

recorder.stop(); // unsubscribe and clear
```

---

## 8. Fixture factories and the real test client

These four also ship on `@avsbhq/test/fixtures`, the entry point with no React and no mocks in it. `@avsbhq/vue/testing` and `@avsbhq/svelte/testing` re-export them from there, so `createTestDatafile` from either of those and from `@avsbhq/test` is the same function rather than lookalikes that disagree about what "a flag that is on" means.

`@avsbhq/solid/testing` still carries its own copy, deliberately: its `./testing` subpath declares a `solid` export condition pointing at raw source, and raw source shipped to a consumer can only import what the consumer installed. `@avsbhq/react/testing` also keeps its own, because it serves values through the flag's default variation rather than a rule, so its reads report `source: 'default'` and fire no exposure.

```ts
import {
  createTestClient,
  createTestDatafile,
  createTestContext,
  createMultiTestContext,
} from '@avsbhq/test';

// A REAL AvsbClient over that datafile: real evaluator, real type checks,
// real source values. Nothing is fetched, polling is off, logging is silent.
const client = createTestClient({ flags: { 'checkout_v2': true } });
expect(client.getBoolFlag('checkout_v2', false).isEnabled()).toBe(true);

// The datafile a flags map describes. Each entry becomes a flag served to
// everyone through a 100% A/B rule, so reads report source: 'rule' and
// record an exposure, exactly as a fully rolled-out flag does in production.
const datafile = createTestDatafile({ 'checkout_v2': true, 'cta_copy': 'Buy now' });

// createTestContext takes PARTIAL CONTEXT FIELDS, not a key string.
const ctx = createTestContext({ key: 'u_123', plan: 'pro' });
// { kind: 'user', key: 'u_123', plan: 'pro' }

const multiCtx = createMultiTestContext({
  user: { kind: 'user', key: 'u_123', plan: 'pro' },
  organization: { kind: 'organization', key: 'org_456', tier: 'enterprise' },
});
```

Full signatures:

```ts
function createTestClient(options?: {
  flags?: TestFlags;
  context?: EvalContext;
  datafile?: FlagDatafile;
}): AvsbClient;

type TestFlagValue = boolean | string | number | object | null;
type TestFlags = Record<string, TestFlagValue>;

function createTestDatafile(
  flags?: TestFlags,
  options?: {
    sdkKey?: string;
    environmentKey?: string;
    /** Move it forward to simulate a republish and wake subscribers. */
    publishedAt?: string;
    /** Hand-built entries, for audiences, rollouts, or per-user overrides. */
    entries?: FlagDatafileEntry[];
  },
): FlagDatafile;
```

Three details worth knowing:

- `@avsbhq/react/testing` has its own `createTestClient(flags, options)`, which takes the flags map as its FIRST argument. This one takes a single options object, `createTestClient({ flags })`. A bare flags map passed here is a type error in TypeScript, and in plain JavaScript it gives you a client with no flags.
- The datafile's `collectEndpoint` is `https://collect.test.invalid`. `.invalid` is a reserved TLD that never resolves, so a stray flush in a test cannot reach a real host.
- `createTestClient` reaches the network at no point, and that includes `await client.onReady()`. `onReady` skips its lazy init once the result has settled, and handing the datafile in settles it. Awaiting readiness is what every framework provider does on mount, so this is the difference between a silent suite and one request per test client.

---

## 9. `Flag<T>` fixtures without a client

```ts
import { createFlag, notFoundFlag, notReadyFlag } from '@avsbhq/core';

const FLAG_ON = createFlag<boolean>({
  value: true,
  variationKey: 'on',
  source: 'rule',
  ruleId: 'r1',
  ruleType: 'ab_test',
  reasons: ['matched audience: paid-users'],
});

const MISSING = notFoundFlag<boolean>(false, 'flag not in datafile');
const TOO_EARLY = notReadyFlag<boolean>(false, 'SDK not ready');
```

---

## 10. Migration

### From LaunchDarkly `LDTestData`

| LaunchDarkly                                  | `@avsbhq/test`                                         |
| --------------------------------------------- | ------------------------------------------------------ |
| `LDTestData.dataSource()`                     | `createMockClient(flagsFromTestData([...]))`           |
| `td.flag('key').booleanFlag()`                | `TestData.flag('key').booleanFlag()`                   |
| `td.flag('key').variationForUser(user, true)` | `TestData.flag('key').variationForUser(userKey, true)` |
| `td.flag('key').fallthroughVariation(false)`  | same                                                   |
| `td.build()` passed to init                   | `createMockClient(flagsFromTestData([td.build()]))`    |

### From Statsig local bootstrap

| Statsig                                         | `@avsbhq/test`                               |
| ----------------------------------------------- | -------------------------------------------- |
| `new StatsigServer(key, { localMode: true })`   | `createMockServer({ flags: {...} })`         |
| `override.overrideGate('key', true)`            | `createMockClient({ flags: { key: true } })` |
| `statsig.logEvent(...)` then `getEventLogQueue` | `client.track(...)` then `client._tracked()` |

### From an earlier @avsbhq/test

| Was                                               | Now                                                     |
| ------------------------------------------------- | ------------------------------------------------------- |
| `createMockClient({ flags: [td.build()] })`       | `createMockClient(flagsFromTestData([td.build()]))`     |
| `<AvsbTestProvider mockFlags={{...}}>`            | `<AvsbTestProvider flags={{...}}>`                      |
| `@avsbhq/test/jest` preset                        | deleted; see section 1                                  |
| vitest `plugins: [avsbPlugin()]`                  | `setupAvsbTest()` from `@avsbhq/test/vitest`            |
| `createTestDatafile({ flags: [entry] })`          | `createTestDatafile({}, { entries: [entry] })`          |
| `createTestContext('u_123', { plan })`            | `createTestContext({ key: 'u_123', plan })`             |
| `import { AvsbTestProvider } from '@avsbhq/test'` | `import { AvsbTestProvider } from '@avsbhq/test/react'` |

`createTestDatafile` swapped its parameters (breaking change B34). The first argument is now the flagKey to value MAP, which is what four of the five copies of this function already took and what every example writes; hand-built `FlagDatafileEntry` objects moved to `options.entries`. TypeScript rejects the old call rather than silently building an empty datafile. Reads on a mapped flag now report `source: 'rule'` and record an exposure, where an entry-less datafile reported nothing at all.
