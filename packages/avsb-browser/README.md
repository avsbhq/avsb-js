# @avsbhq/browser

Browser client SDK for the [A vs B](https://app.avsb.cloud) platform.

Evaluate feature flags, run A/B experiments, and track conversion events in any browser context. For React apps, use [`@avsbhq/react`](https://www.npmjs.com/package/@avsbhq/react) which wraps this SDK with hooks and a provider.

---

## 1. Install

```bash
npm install @avsbhq/browser
```

Requires a modern browser with ES2020 support. Both ESM and CJS builds are shipped, each with its own type declarations (`.d.ts` for `import`, `.d.cts` for `require`), so TypeScript resolves types under `node16`, `nodenext` and `bundler` alike.

No peer dependencies to install. `@avsbhq/core` and `@avsbhq/utils` are real dependencies and arrive with this package, so the pino and winston logger adapters, the OpenFeature provider, and the framework middleware are already on disk at `@avsbhq/utils/*` with nothing further to install.

---

## 2. Quickstart

```ts
import { AvsbClient } from '@avsbhq/browser';
import type { Flag, InitResult } from '@avsbhq/browser';

declare function renderNewCheckout(): void;

const client: AvsbClient = new AvsbClient({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  context: { kind: 'user', key: 'u_123', plan: 'pro' },
});

const result: InitResult = await client.onReady();
if (!result.success) {
  // Nothing could be loaded. Every flag returns the default you pass.
  // result.error is an Error whose message names the status, the URL, and the fix.
  console.warn(result.error?.message);
}

const flag: Flag<boolean> = client.getBoolFlag('new_checkout_flow', false);
if (flag.isEnabled()) {
  renderNewCheckout();
}

client.track('checkout_started', { revenue: 99.0 });

// Flush and tear down before the app unloads
window.addEventListener('beforeunload', () => {
  void client.close();
});
```

Construct the client once at application boot, not per page or per component.

**The constructor starts loading immediately.** You do not have to call anything to begin: `new AvsbClient({ sdkKey })` validates the key, resolves a stable visitor id, serves any cached datafile, and starts the network fetch. `onReady()` is how you wait for the result, not how you start it. Pass `autoInit: false` if you want to build the client now and load later (tests, or a server render).

---

## 3. SDK keys

Get the SDK key for the environment you want to target from your A vs B project:

1. Log in to [app.avsb.cloud](https://app.avsb.cloud)
2. Open your project, then **Environments** in the project sidebar
3. Copy the SDK key (format `sdk_<environment>_<id>`, for example `sdk_production_ttqm0eaj4vth1krcb2xn`)

SDK keys are scoped to a single environment and grant flag-read access only: they cannot write to your project or read from other environments. They are safe to embed in browser bundles within those bounds.

```
VITE_AVSB_SDK_KEY=sdk_production_...
NEXT_PUBLIC_AVSB_SDK_KEY=sdk_production_...
```

The client checks the shape of the key at construction. A key that does not look like an SDK key (a pasted dashboard URL, a truncated copy, a personal access token or a service token) logs one actionable error naming what it got and where the real key lives, then carries on: the datafile request is the real test.

---

## 4. The whole type surface

Every public method, with its real signature. Nothing here is overloaded or
optional-by-magic: what you see is what the compiler sees.

Every type named below is exported by the package, so your own declarations can
import them from the same place:

```ts
import type {
  AvsbClientOptions,
  BrowserEventOptions,
  BrowserLogLevel,
  ClientEventMap,
  ClientEventName,
  DecideOption,
  EvalContext,
  EvaluationSource,
  FlagDatafile,
  FlagSnapshot,
  GetAllFlagsOptions,
  GetFlagOptions,
  Logger,
  RuleType,
  TrackPayload,
} from '@avsbhq/browser';
```

```ts
class AvsbClient {
  constructor(options: AvsbClientOptions);

  // Lifecycle
  onReady(options?: { timeout?: number }): Promise<InitResult>;
  isReady(): boolean;
  getInitResult(): InitResult | null;
  applyDatafileBootstrap(datafile: FlagDatafile): void;
  applySnapshot(snapshot: FlagSnapshot): void;
  refresh(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;

  // Identity
  identify(context: EvalContext): void;
  updateAttributes(partial: Record<string, unknown>, contextKind?: string): void;
  alias(previousContext: EvalContext, newContext: EvalContext): void;
  getContext(): EvalContext;
  reset(): void;

  // Reading flags
  getFlag<T>(flagKey: string, defaultValue: T, options?: GetFlagOptions): Flag<T>;
  getBoolFlag(flagKey: string, defaultValue: boolean, options?: GetFlagOptions): Flag<boolean>;
  getStringFlag(flagKey: string, defaultValue: string, options?: GetFlagOptions): Flag<string>;
  getNumberFlag(flagKey: string, defaultValue: number, options?: GetFlagOptions): Flag<number>;
  getJsonFlag<T>(flagKey: string, defaultValue: T, options?: GetFlagOptions): Flag<T>;
  getAllFlags(options?: GetAllFlagsOptions): Record<string, Flag>;

  // Store contract for framework adapters
  subscribe(flagKey: string, listener: () => void): () => void;
  getSnapshot<T>(flagKey: string, defaultValue: T): Flag<T>;

  // Events
  track(eventKey: string, payload?: TrackPayload): void;
  on<E extends ClientEventName>(event: E, cb: ClientEventMap[E]): () => void;
  onFlagChange(
    callback: (flagKey: string, newValue: unknown, oldValue: unknown) => void,
  ): () => void;

  // Runtime overrides (QA and local development)
  setOverrideForUser(
    flagKey: string,
    contextKey: string,
    variationKey: string,
    contextKind?: string,
  ): void;
  setGlobalOverride(flagKey: string, variationKey: string): void;
  clearOverrideForUser(flagKey: string, contextKey: string, contextKind?: string): void;
  clearGlobalOverride(flagKey: string): void;
  clearAllOverrides(): void;

  // Extras (debounce, retry, snapshots, storage adapters, OpenFeature)
  readonly utils: AvsbUtils;
}
```

`on` and `subscribe` both return their own unsubscribe function: `() => void`.
Every method that can fail resolves rather than rejecting, so no call above
needs a `try` block except your own code inside a callback.

### `AvsbClientOptions`

```ts
interface AvsbClientOptions {
  sdkKey: string;
  context?: EvalContext; // THE identity model; see the note below
  pollingInterval?: number; // default 60_000, clamped to a 5_000 minimum
  autoRefresh?: boolean; // default true
  bootstrap?: FlagDatafile;
  cdnHost?: string; // default 'https://cdn.avsb.cloud'
  autoInit?: boolean; // default true: start loading from the constructor
  initTimeout?: number; // default 10_000, per datafile request
  cache?: boolean; // default true: localStorage datafile cache
  cacheMaxAgeMs?: number; // default 604_800_000 (7 days)
  adoptSnippetVisitorId?: boolean; // default true
  pauseWhenHidden?: boolean; // default true
  refetchOnFocus?: boolean; // default true
  maxPendingEvents?: number; // default 100
  events?: BrowserEventOptions;
  logger?: Logger;
  logLevel?: BrowserLogLevel; // 'silent' | 'debug' | 'info' | 'warn' | 'error'
  onError?: (e: Error, source: 'init' | 'poll' | 'stream' | 'track' | 'eval') => void;
  streaming?: boolean; // default false
  streamingEndpoint?: string; // normally published in the datafile
}
```

`context` is the ONE identity model. The parallel `attributes` and
`userIdAttribute` options were deleted (breaking change B5): two models meant
every adapter and doc had to teach both, and the second could not express
multi-context at all. Migration is mechanical:

```ts
const sdkKey = 'sdk_production_ttqm0eaj4vth1krcb2xn';

// Was:  new AvsbClient({ sdkKey, attributes: { userId: 'u_1', plan: 'pro' } })
new AvsbClient({ sdkKey, context: { kind: 'user', key: 'u_1', plan: 'pro' } });
```

```ts
interface BrowserEventOptions {
  flushInterval?: number; // default 2000
  batchSize?: number; // default 10
  maxQueueSize?: number; // default 500
  retryAttempts?: number; // default 3
}

interface GetFlagOptions {
  fireExposure?: boolean; // default true
  readOnly?: boolean; // default false: render-safe, cached, no side effects
  decideOptions?: DecideOption[]; // DISABLE_EXPOSURE is honoured here
}

interface GetAllFlagsOptions {
  fireExposures?: boolean; // default false
  context?: EvalContext; // evaluate for someone else without rebinding
}
```

`GetAllFlagsOptions` has no `decideOptions`: a bulk read already suppresses
exposures by default, so `DISABLE_EXPOSURE` would just be a second name for
`fireExposures: false`.

### `Flag<T>`

The return type of every read. Exact shape, from `@avsbhq/core`:

```ts
interface Flag<T = unknown> {
  /** The variation value typed against the default. */
  readonly value: T;
  /** Variation key (null if served the default or not found). */
  readonly variationKey: string | null;
  /** Why this value was produced. */
  readonly source: EvaluationSource;
  /** Rule that matched (null when source is 'default'/'not_found'/etc). */
  readonly ruleId: string | null;
  /** Rule type that matched (null when no rule applied). */
  readonly ruleType: RuleType | null;
  /** Structured reasons for this decision. */
  readonly reasons: string[];
  /** ms-epoch when evaluated. */
  readonly evaluatedAt: number;
  /** µs elapsed in the evaluator. */
  readonly durationMicros: number;
  /** Convenience: a real decision produced a truthy value. */
  isEnabled(): boolean;
  /** Convenience: false for 'not_found' and for 'not_ready'. */
  exists(): boolean;
}

type RuleType = 'targeted_delivery' | 'ab_test' | 'holdout' | 'bandit';
```

The object is frozen. `reasons` is never null; it is an empty array only when
the evaluator had nothing to say.

### `EvaluationSource`, member by member

```ts
type EvaluationSource =
  | 'datafileOverride'
  | 'runtimeOverride'
  | 'sticky'
  | 'rule'
  | 'holdout'
  | 'bandit'
  | 'default'
  | 'not_found'
  | 'disabled'
  | 'not_ready';
```

| Member             | Meaning                                                                | `isEnabled()`   | `exists()` |
| ------------------ | ---------------------------------------------------------------------- | --------------- | ---------- |
| `datafileOverride` | A per-user override configured in the dashboard matched.               | value-dependent | true       |
| `runtimeOverride`  | `setOverrideForUser` or `setGlobalOverride` matched.                   | value-dependent | true       |
| `sticky`           | A previously stored assignment was reused.                             | value-dependent | true       |
| `rule`             | A targeting rule or A/B rule matched.                                  | value-dependent | true       |
| `holdout`          | The visitor is in a holdout, so the holdout variation was served.      | value-dependent | true       |
| `bandit`           | A bandit rule picked the variation.                                    | value-dependent | true       |
| `default`          | The flag exists, nothing matched, so its default variation was served. | false           | true       |
| `disabled`         | The flag exists but is switched off in this environment.               | false           | true       |
| `not_found`        | The datafile loaded and does not contain this key. Check the key name. | false           | false      |
| `not_ready`        | The SDK has no datafile yet. Await `onReady()`, or pass `bootstrap`.   | false           | false      |

"value-dependent" means `isEnabled()` is `Boolean(flag.value)`: a real decision
was made, so the answer is whatever that decision produced.

### `InitResult`

```ts
interface InitResult {
  success: boolean;
  /** 'cache' deliberately removed; never returned by current code. */
  source: 'network' | 'bootstrap' | 'timeout' | 'error';
  error?: Error;
  /**
   * Serving STALE-BUT-REAL flag values: a bootstrap or a cached datafile is
   * loaded and readable, and a refresh of it failed. `success` is `true`
   * because flags are answerable; polling continues in the background.
   *
   * It is never set when there is nothing to serve. A failed fetch with no
   * bootstrap and no cache resolves `{success: false, source: 'error'}` (spec
   * §1.2, breaking change B1); reading "degraded" as "the SDK is fine on
   * defaults" was the bug that let a typo'd SDK key look healthy.
   */
  degraded?: boolean;
}
```

### Context types

```ts
interface ContextMeta {
  /** Attribute keys redacted from exposure events and decision-log reasons. */
  privateAttributes?: string[];
  /** Mark this context as anonymous (suppresses some integrations). */
  anonymous?: boolean;
}

interface SingleContext {
  /** Context kind. 'user' is conventional but not enforced. */
  kind: string;
  /** Unique key within the kind (bucketing identifier for this kind). */
  key: string;
  /** Optional human-readable name (UI display only, not used in eval). */
  name?: string;
  /** Reserved metadata. */
  _meta?: ContextMeta;
  /** Targeting attributes. Reserved keys: 'kind', 'key', 'name', '_meta'. */
  [attribute: string]: unknown;
}

interface MultiContext {
  kind: 'multi';
  /** Keyed by context kind. At least one entry required (other than 'kind'). */
  [contextKind: string]: SingleContext | 'multi';
}

type EvalContext = SingleContext | MultiContext;
```

Because `SingleContext` carries an index signature, attribute values are typed
`unknown`. Narrow before use, or build contexts with `defineContextSchema` from
`@avsbhq/utils` for a typed factory:

```ts
const ctx: EvalContext = client.getContext();
const plan: unknown = 'plan' in ctx ? ctx['plan'] : undefined;
if (typeof plan === 'string') {
  // plan is a string here
}
```

### `TrackPayload`

```ts
interface TrackPayload {
  /** Numeric metric value. Generalises 'revenue': any quantity. */
  value?: number;
  /** Free-form properties forwarded to analytics. */
  properties?: Record<string, unknown>;
  /** Override the context to track against (server SDK only). */
  context?: EvalContext;
}
```

`context` is ignored by this SDK: the browser client always tracks against its
bound context. It exists on the shared type because the server SDKs honour it.

### Typed flag keys

Every key parameter above is `string` until you generate your keys. Generate
them and it becomes the union of this project's real flag keys, so a typo is a
compile error and your editor completes the list:

```bash
npx @avsbhq/cli codegen --output src/generated/flags.ts
```

The generated file declares your flags twice on purpose: an importable
`FlagValues` interface for payload types, and a `declare global` block that
teaches every getter in this package which keys exist. Its important parts:

```text
// AUTO-GENERATED by @avsbhq/cli codegen. Do not edit by hand.

export interface FlagValues {
  'checkout_v2': boolean
  'hero_copy': 'control' | 'variant_a'
  'theme': { primary: string }
}

declare global {
  interface AvsbFlags {
    'checkout_v2': boolean
    'hero_copy': 'control' | 'variant_a'
    'theme': { primary: string }
  }
}
```

```ts
import type { FlagValues } from './generated/flags';

const typedCheckout = client.getBoolFlag('checkout_v2', false);

// A JSON flag types its payload from the generated table:
const typedTheme = client.getJsonFlag<FlagValues['theme']>('theme', { primary: '#111' });

// Once the generated file exists, this line stops compiling:
// 'chekcout_v2' is not a flag key.
const typedTypo = client.getBoolFlag('chekcout_v2', false);
```

Nothing changes for a project that never runs `codegen`: with no generated file
the table is empty, every key parameter is exactly `string`, and every call you
have already written compiles unchanged. For a key computed at runtime, widen
deliberately with `key as AvsbFlagKey` (that type is exported from
`@avsbhq/browser` and from `@avsbhq/core`).

---

## 5. Lifecycle and readiness

```ts
client.isReady(); // boolean: are flags readable right now?
await client.onReady(); // Promise<InitResult>, never rejects
client.getInitResult(); // InitResult | null, the settled outcome so far
```

`isReady()` and `onReady()` answer different questions, and the difference matters when caching is on:

- **`isReady()`** is true as soon as flags can be read from something real: a `bootstrap` datafile, a cached datafile from a previous visit, or the network response. It is synchronous, so a framework adapter can decide what to render on the first pass.
- **`onReady()`** resolves when the init attempt settles. With a cached datafile, that is after the background refresh finishes, so `isReady()` can be true while `onReady()` is still pending.

`InitResult` shapes:

| Result                                               | Meaning                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `{ success: true, source: 'network' }`               | The datafile was fetched (or confirmed unchanged with a 304).                                                             |
| `{ success: true, source: 'bootstrap' }`             | You supplied the datafile. No fetch was needed.                                                                           |
| `{ success: true, degraded: true, source: 'error' }` | A cached datafile is being served after a failed refresh. Flags work; they may be stale.                                  |
| `{ success: false, source: 'error', error }`         | Nothing could be loaded. Every flag returns the default you pass. `error.message` names the status, the URL, and the fix. |
| `{ success: false, source: 'timeout', error }`       | Your `onReady({ timeout })` elapsed first.                                                                                |

### `onReady({ timeout })`

```ts
const result = await client.onReady({ timeout: 2000 });
```

The timeout bounds how long **you** wait, not what the SDK does: loading continues in the background, so a client that timed out at 2 seconds can be ready a moment later. Watch `on('ready', ...)` or `isReady()` if you want to know when that happens.

### Events

```ts
client.on('ready', (result) => {}); // fires once, when flags become readable
client.on('error', (error) => {}); // init or refresh failure, with an actionable message
client.on('configUpdate', ({ publishedAt, reason }) => {}); // a new datafile was applied
client.on('flagChange', ({ flagKey, previousValue, newValue }) => {});
```

When the first datafile lands, `flagChange` fires once per flag (moving from "unknown" to its value), and every per-flag subscriber is notified. After that, only flags whose value actually changed fire.

---

## 6. Identity

Anonymous visitors get a **persisted** id (`localStorage`, with a cookie fallback), so a returning visitor buckets into the same variation instead of being re-randomised on every page load.

If the A vs B web snippet is installed on the same page, the client adopts its `_avsb_visitor` id so feature flag exposures and web experiment exposures join to one visitor in your results. The SDK only reads that cookie; it never writes it. Pass `adoptSnippetVisitorId: false` to opt out.

### `identify(context: EvalContext): void`

Replace the current evaluation context entirely. All flags are re-evaluated and any changed flags emit a `flagChange` event. Bucketing rehashes immediately.

```ts
declare const user: { id: string; email: string; plan: string };

// After user signs in
client.identify({
  kind: 'user',
  key: user.id,
  email: user.email,
  plan: user.plan,
});
```

### `updateAttributes(partial: Record<string, unknown>, contextKind?: string): void`

Merge new attributes into the current context without replacing the entire context. `contextKind` defaults to `'user'`. When the kind is not present yet, it is added as a new sub-context and the context becomes a multi-context.

```ts
client.updateAttributes({ plan: 'enterprise' });
client.updateAttributes({ tier: 3 }, 'organization');
```

### `alias(previousContext: EvalContext, newContext: EvalContext): void`

Mark the moment a signup or login claimed an anonymous session. Synchronous: it queues one `avsb_alias` event and returns. It used to be declared `async`, which implied awaiting mattered when the promise resolved immediately after a synchronous `track`.

What it does NOT do, precisely:

- It does not rewrite variation assignments, sticky bucketing, or past exposures. Nothing already decided for either identity changes.
- It does not store the PREVIOUS key. The conversion wire (`/v1/collect/metric-batch`) has no properties column, so a retroactive session join is not available yet. The event is attributed to whichever identity the client is bound to, so call `identify(newContext)` first; the SDK warns once if you do not.

To carry bucketing across a login, evaluate with the SAME context key on both sides: keep using the anonymous visitor id after sign-in, or set the account id before the first evaluation.

```ts
declare const anonymousId: string;
declare const user: { id: string };

client.identify({ kind: 'user', key: user.id });
client.alias({ kind: 'user', key: anonymousId }, { kind: 'user', key: user.id });
```

### `reset(): void`

Return to a **new** anonymous identity and clear runtime overrides. Call this on logout: the persisted visitor id is rotated, so the next anonymous session is genuinely a different visitor rather than the person who just signed out.

```ts
client.reset();
```

One caveat when the A vs B web snippet is installed on the same page: the
snippet owns the visitor cookie, and this SDK only reads it. `reset()` therefore
rotates this SDK's own persisted id and rebinds its context, but the next page
load adopts the snippet's visitor id again. Pass `adoptSnippetVisitorId: false`
if you want the SDK's identity to be entirely its own.

### `getContext(): EvalContext`

The current evaluation context. Treat it as read-only: mutating it does not
re-evaluate anything. Use `identify` or `updateAttributes` to change identity.

---

## 7. Multi-context

Evaluate flags simultaneously against multiple context kinds, such as a user, their organization, and their device:

```ts
client.identify({
  kind: 'multi',
  user: { kind: 'user', key: 'u_123', plan: 'pro' },
  organization: { kind: 'organization', key: 'org_456', tier: 'enterprise' },
  device: { kind: 'device', key: 'd_abc', os: 'ios' },
});
```

When a multi-context is active, rules can target any context kind. A rule might bucket on `user.key` while matching an audience condition on `organization.tier`. The `hashAttribute` in each rule's datafile entry controls which context kind drives the bucket.

---

## 8. Reading flags

All evaluation methods return a `Flag<T>` object rather than a raw value. Access `.value` for the primitive or use the convenience methods on the `Flag`.

### Typed variants

```ts
getBoolFlag(flagKey: string, defaultValue: boolean, options?: GetFlagOptions): Flag<boolean>
getStringFlag(flagKey: string, defaultValue: string, options?: GetFlagOptions): Flag<string>
getNumberFlag(flagKey: string, defaultValue: number, options?: GetFlagOptions): Flag<number>
getJsonFlag<T>(flagKey: string, defaultValue: T, options?: GetFlagOptions): Flag<T>
```

Each typed variant checks the value against the type the platform declared for
that flag. **On a mismatch it never throws:** it logs one warning naming the
flag, the getter used, and the declared type, then returns
`Flag<T>` carrying your `defaultValue` with `source: 'not_found'`. Asking for a
string flag with `getNumberFlag` is therefore safe, and visible.

`getJsonFlag<T>` does not validate the shape of `T` at runtime: it checks only
that the platform declared the flag as JSON. Validate the payload yourself (zod
or a type guard) if it crosses a trust boundary.

```ts
const darkMode: Flag<boolean> = client.getBoolFlag('dark_mode', false);
const theme: Flag<string> = client.getStringFlag('theme', 'light');
const maxItems: Flag<number> = client.getNumberFlag('max_results', 25);

interface ApiConfig {
  timeout: number;
  retries: number;
}
const config: Flag<ApiConfig> = client.getJsonFlag<ApiConfig>('api_config', {
  timeout: 5000,
  retries: 3,
});
const timeout: number = config.value.timeout;
```

### Generic `getFlag<T>`

```ts
getFlag<T>(flagKey: string, defaultValue: T, options?: GetFlagOptions): Flag<T>
```

No runtime type check runs here: whatever the datafile says is returned, typed
as `T`. Use it when the type is dynamic, and prefer a typed variant otherwise.
`T` comes from your explicit type argument when you give one, and from the
default value when you do not:

```ts
const inferred: Flag<boolean> = client.getFlag('checkout_v2', false);
const explicit: Flag<string | null> = client.getFlag<string | null>('banner_copy', null);
```

### `getAllFlags(options?: GetAllFlagsOptions): Record<string, Flag>`

Every flag in the datafile, keyed by flag key, each as a `Flag<unknown>`
(`Flag`'s default type argument). Exposures are suppressed by default, and the
returned object is the same object between changes, so it is safe to read on
every render. Before the SDK is ready this returns `{}` and logs one warning
saying why, rather than looking like a project with no flags.

```ts
const all: Record<string, Flag> = client.getAllFlags();
const withExposures: Record<string, Flag> = client.getAllFlags({ fireExposures: true });

// Evaluate for someone else without changing the bound context.
const forOtherUser: Record<string, Flag> = client.getAllFlags({
  context: { kind: 'user', key: 'u_999', plan: 'pro' },
});

const value: unknown = all['dark_mode']?.value;
```

### Render-safe reads

For code that runs during render (a React hook, a Vue computed, a Svelte store), use read-only mode:

```ts
// generic
const snapshot: Flag<boolean> = client.getSnapshot('checkout_v2', false);
// typed, with the same runtime type check as a normal typed read
const typed: Flag<boolean> = client.getBoolFlag('checkout_v2', false, { readOnly: true });
```

A read-only read:

- returns the **same object** until that flag's value changes, which is what `useSyncExternalStore` and every equivalent store API require;
- fires **no exposure** and emits no `evaluation` event, because a render is a read, not a decision.

Pair it with `subscribe` to re-read when the value moves:

```ts
const unsubscribe: () => void = client.subscribe('checkout_v2', () => {
  // this flag changed, or the SDK just became ready
});
```

Fire the exposure once, where the decision is actually shown to the user, with a normal (non read-only) read.

### The store contract, for framework adapters

If you are writing an integration (or reading `@avsbhq/react`, `@avsbhq/vue`,
`@avsbhq/svelte`, `@avsbhq/solid`, `@avsbhq/angular`, `@avsbhq/react-native`, or
`@avsbhq/next`), these methods are the whole contract:

```ts
subscribe(flagKey: string, listener: () => void): () => void
getSnapshot<T>(flagKey: string, defaultValue: T): Flag<T>
getBoolFlag(flagKey: string, defaultValue: boolean, options?: GetFlagOptions): Flag<boolean>
// and the other typed getters, called with { readOnly: true }
isReady(): boolean
getInitResult(): InitResult | null
```

Guaranteed:

1. **Identity stability.** Two read-only reads of the same key with the same
   default return the same object, until that flag's value, variation, source,
   or rule changes. Different defaults for the same key get their own stable
   objects.
2. **Wake-up on ready.** Every subscriber is called once when the first datafile
   is applied, including subscribers for keys the datafile does not contain
   (their answer moves from `not_ready` to `not_found`).
3. **Targeted notification.** After that, only subscribers of flags whose value
   changed are called. An unrelated flag changing neither wakes you nor changes
   your snapshot's identity.
4. **No side effects on read.** Read-only reads fire no exposure and emit no
   `evaluation` event, so a discarded or replayed render cannot corrupt results.
5. **Synchronous readiness.** `isReady()` and `getInitResult()` answer without
   awaiting, so a first render can choose between a value, a loading state, and
   an error state.

A React hook is then exactly this:

```ts
import { useSyncExternalStore } from 'react';
import { AvsbClient } from '@avsbhq/browser';
import type { Flag } from '@avsbhq/browser';

export function useBoolFlag(
  client: AvsbClient,
  flagKey: string,
  defaultValue: boolean,
): Flag<boolean> {
  return useSyncExternalStore(
    (onStoreChange: () => void) => client.subscribe(flagKey, onStoreChange),
    () => client.getBoolFlag(flagKey, defaultValue, { readOnly: true }),
    () => client.getBoolFlag(flagKey, defaultValue, { readOnly: true }),
  );
}
```

### `DecideOption`: per-call overrides

```ts
import { DecideOption } from '@avsbhq/browser';
import type { Flag } from '@avsbhq/browser';

const flag: Flag<boolean> = client.getBoolFlag('my_flag', false, {
  decideOptions: [DecideOption.DISABLE_EXPOSURE],
});
```

- `DISABLE_EXPOSURE`: do not fire an exposure event for this call. Same as `{ fireExposure: false }`.
- `INCLUDE_REASONS`: accepted and always satisfied. The browser client collects `flag.reasons` on every evaluation.

---

## 9. Caching and offline behaviour

The client caches the datafile in `localStorage` and serves it on the next visit while a refresh runs behind it (cache-then-network). That makes second loads instant and keeps flags working when the network is unavailable.

```ts
const client = new AvsbClient({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  cache: false, // opt out of the datafile cache entirely
  cacheMaxAgeMs: 86_400_000, // ignore anything cached more than a day ago (default 7 days)
});
```

Details worth knowing:

- Refreshes are conditional. The cached ETag is sent as `If-None-Match`, so an unchanged datafile costs a 304 with no body.
- Only network responses are cached. A `bootstrap` datafile you pass in is never written to the cache.
- A cached datafile that fails validation is discarded rather than trusted.
- If a refresh fails while a cached datafile is being served, `onReady()` resolves `{ success: true, degraded: true }`. Flags keep working; they may be stale.
- Polling is clamped to a 5 second minimum, jittered, paused while the tab is hidden, and refreshed when the window regains focus.

```ts
const client = new AvsbClient({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  pollingInterval: 60_000, // default 60s, clamped to 5s minimum
  pauseWhenHidden: false, // keep polling in background tabs
  refetchOnFocus: false, // do not refetch when the tab regains focus
  autoRefresh: false, // no polling at all
});
```

---

## 10. Tracking events

```ts
client.track('purchase_completed', { revenue: 199.0 }); // money
client.track('items_added', { value: 3 }); // a quantity
client.track('checkout_started'); // a count
```

`TrackPayload` fields:

- `revenue`: money in decimal MAJOR units of the project currency (49.99, not 4999). Lands in the storage column `revenue`.
- `value`: numeric metric value for average-value metrics (items, seats, seconds). Lands in the SEPARATE storage column `value`.
- `properties`: accepted by the shared type, but NOT stored for conversions. The ingestion contract for `/v1/collect/metric-batch` declares no properties column, so anything sent under that name is dropped at the edge; this SDK does not put it on the wire. Exposure events do carry properties.

`revenue` and `value` are two columns end to end, so one conversion can carry money, a quantity, or both. Earlier releases mapped `value` into the revenue column, which recorded a quantity as money.

Delivery is durable:

- Events are batched and flushed on an interval, and on tab hide via `sendBeacon`.
- A failed send is retried on an exponential backoff curve with jitter, honouring `Retry-After`.
- A batch that still fails goes back on the queue and is retried on the next flush, instead of being dropped.
- Queues are bounded. Past the cap the oldest events are dropped and one warning names the endpoint that is not answering.
- Events tracked before the client is ready are held (bounded) and flushed as soon as it is.

```ts
const client = new AvsbClient({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  maxPendingEvents: 100, // held before the SDK is ready
  events: {
    flushInterval: 2000,
    batchSize: 10,
    maxQueueSize: 500,
    retryAttempts: 3,
  },
});
```

---

## 11. Logging and error handling

### Defaults

The default logger writes to the console at `warn` level in development and is silent everywhere else. Development is detected in this order:

1. `globalThis.__AVSB_DEV__` when you set it. This is the bundler hook:
   - Vite: `define: { __AVSB_DEV__: 'import.meta.env.DEV' }`
   - webpack: `new DefinePlugin({ __AVSB_DEV__: 'process.env.NODE_ENV !== "production"' })`
2. `NODE_ENV` when a real `process` exists (Node, SSR, test runners). `production` and `test` are silent; anything else is development.
3. Otherwise, the host: `localhost`, `127.0.0.1`, `*.local`, and private LAN addresses count as development.

Override it explicitly whenever you want:

```ts
const client = new AvsbClient({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  logLevel: 'debug', // or 'silent' to turn SDK logging off entirely
});
```

### Custom logger

```ts
import { AvsbClient, createLogger, consoleTransport } from '@avsbhq/browser';
import type { Logger } from '@avsbhq/browser';

const logger: Logger = createLogger({
  level: 'info',
  transports: [consoleTransport('warn')],
});

const client = new AvsbClient({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  logger,
});
```

For pino or winston adapters:

```ts
import { createLogger } from '@avsbhq/browser';
import { createPinoTransport } from '@avsbhq/utils/log/pino';
import pino from 'pino';

const logger = createLogger({
  level: 'info',
  transports: [createPinoTransport({ logger: pino(), level: 'info' })],
});
```

### `onError` callback

```ts
declare const myMonitoring: {
  captureException: (e: Error, ctx: { tags: Record<string, string> }) => void;
};

const client = new AvsbClient({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  onError: (err: Error, source: 'init' | 'poll' | 'stream' | 'track' | 'eval') => {
    myMonitoring.captureException(err, { tags: { source } });
  },
});
```

`source` is one of `'init' | 'poll' | 'stream' | 'track' | 'eval'`. Network failures arrive as `AvsbNetworkError` and timeouts as `AvsbTimeoutError`, both exported from this package, so you can branch on the cause instead of matching message strings:

```ts
import { AvsbNetworkError, AvsbTimeoutError } from '@avsbhq/browser';

function describe(error: unknown): string {
  if (error instanceof AvsbTimeoutError) return `slow host: ${error.host}`;
  if (error instanceof AvsbNetworkError) return `unreachable host: ${error.host}`;
  return error instanceof Error ? error.message : String(error);
}
```

---

## 12. Server rendering and bootstrap

Pre-fetch the datafile on the server and pass it as `bootstrap` to skip the initial network round-trip on the client:

```ts
// Server
import { fetchDatafile } from '@avsbhq/browser/server';
import type { FlagDatafile } from '@avsbhq/browser';

declare const sdkKey: string;

// fetchDatafile(sdkKey: string, options?: { cdnHost?: string; timeout?: number;
//   onError?: (error: Error) => void }): Promise<FlagDatafile | null>
const datafile: FlagDatafile | null = await fetchDatafile(sdkKey, { timeout: 2000 });
// Serialise `datafile` into the page. It is null when the fetch failed, in
// which case the browser client falls back to fetching it itself.
```

```ts
// Client
import { AvsbClient } from '@avsbhq/browser';
import type { EvalContext, FlagDatafile } from '@avsbhq/browser';

declare const userContext: EvalContext;
declare const datafileFromServer: FlagDatafile;

const client = new AvsbClient({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  context: userContext,
  bootstrap: datafileFromServer,
});
// isReady() is already true; onReady() resolves with source: 'bootstrap'.
```

Bootstrap guarantees the same variation values on the server render and the initial client render, preventing hydration mismatches.

You can also apply a datafile after construction, which is what the bootstrap-blob helper in `@avsbhq/utils` does:

```ts
client.applyDatafileBootstrap(datafileFromServer);
```

For Next.js App Router, use `@avsbhq/next` and its server components instead of wiring this manually.

---

## 13. Streaming updates

Streaming is opt-in in the browser. The endpoint is published by the platform in the datafile, so nothing needs configuring:

```ts
const client = new AvsbClient({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  streaming: true,
});
```

If the datafile carries no stream endpoint and you passed none, the client says so in one log line and stays on polling. It never guesses a host.

---

## 14. Graceful shutdown

```ts
await client.flush(); // drain queued events, sendBeacon or fetch({ keepalive: true })
await client.close(); // flush, stop polling, disconnect streaming, destroy the tracker
```

`close()` flushes internally, so calling both is safe but redundant. `track()` after `close()` is dropped with one warning rather than silently.

---

## 15. Testing

Install `@avsbhq/test` and use `createMockClient` to replace the real SDK in tests:

```ts
import { createMockClient } from '@avsbhq/test';

const client = createMockClient({
  flags: { 'checkout_v2': true },
});

expect(client.getBoolFlag('checkout_v2', false).value).toBe(true);
```

To test against the real client without a network, pass a `bootstrap` datafile and turn the extras off:

```ts
import { AvsbClient } from '@avsbhq/browser';
import type { FlagDatafile } from '@avsbhq/browser';

declare const myTestDatafile: FlagDatafile;

const client = new AvsbClient({
  sdkKey: 'sdk_test_000000000000',
  bootstrap: myTestDatafile,
  autoRefresh: false,
  cache: false,
  logLevel: 'silent',
});
```

---

## 16. Breaking changes in this release

| Change                                                                                                                                                                               | What to do                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| A failed init with nothing to fall back on now resolves `{ success: false }`. It used to resolve `{ success: true, degraded: true }`, which made a typo'd SDK key look like success. | Branch on `result.success`. `degraded: true` now means only "serving a stale cached datafile after a failed refresh". |
| The default logger writes to the console at `warn` level in development. It used to be silent everywhere.                                                                            | Nothing, unless you want silence: pass `logLevel: 'silent'`.                                                          |
| A read before the datafile loads reports `source: 'not_ready'`. It used to report `not_found`.                                                                                       | Treat `not_ready` as "ask again after `onReady()`".                                                                   |
| `getAllFlags({ context })` now evaluates against the context you pass. It used to ignore it and answer for the bound context.                                                        | Nothing, unless you were relying on the bug.                                                                          |
| The constructor starts loading the datafile. It used to wait for `onReady()`.                                                                                                        | Nothing. Pass `autoInit: false` if you need the old timing.                                                           |
| `DecideOption` members other than `DISABLE_EXPOSURE` and `INCLUDE_REASONS` are gone.                                                                                                 | Remove them. They were never implemented.                                                                             |

---

## 17. Migration

### From LaunchDarkly JS

| LaunchDarkly JS                          | `@avsbhq/browser`                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `initialize(clientId, context, options)` | `new AvsbClient({ sdkKey, context })`                                      |
| `client.waitForInitialization()`         | `await client.onReady()`                                                   |
| `bootstrap: 'localStorage'`              | on by default (`cache: true`)                                              |
| `client.variation('key', default)`       | `client.getBoolFlag('key', false).value`                                   |
| `client.variationDetail('key', default)` | `client.getFlag('key', default)`                                           |
| `client.identify(context)`               | `client.identify(context)`                                                 |
| `client.track('event', { metricValue })` | `client.track('event', { revenue })` for money, `{ value }` for a quantity |
| `client.on('change:key', cb)`            | `client.subscribe('key', cb)` or `client.on('flagChange', cb)`             |
| `client.flush()`                         | `await client.flush()`                                                     |

Key differences:

- `getFlag` returns a `Flag<T>` object, not a raw value. Access `.value` for the primitive.
- All typed variants (`getBoolFlag`, `getStringFlag`, and so on) require an explicit `defaultValue`.
- `track` splits the number in two: `revenue` for money, `value` for an average-value quantity. LaunchDarkly's single `metricValue` maps to whichever of the two you mean.
- Multi-context is a first-class concept with kinded `EvalContext` rather than a separate wrapper type.

### From Statsig JS

| Statsig JS                                           | `@avsbhq/browser`                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Statsig.initialize(clientKey, user)`                | `new AvsbClient({ sdkKey, context })`                                                                              |
| `Statsig.checkGate('key')`                           | `client.getBoolFlag('key', false).isEnabled()`                                                                     |
| `Statsig.getExperiment('key').get('param', default)` | `client.getFlag('key', default).value`                                                                             |
| `Statsig.logEvent('event', value, metadata)`         | `client.track('event', { value })` for a quantity, `{ revenue }` for money. Metadata is not stored on conversions. |
| `Statsig.updateUser(user)`                           | `client.identify(context)`                                                                                         |
