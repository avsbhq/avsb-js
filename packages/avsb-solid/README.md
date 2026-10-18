# @avsbhq/solid

Solid SDK for the [A vs B](https://app.avsb.cloud) platform.

Mount one `<AvsbProvider>`, then read feature flags with accessors. Built on [`@avsbhq/browser`](https://www.npmjs.com/package/@avsbhq/browser): a component re-runs when the flag it reads changes, and only then.

---

## 1. Install

```bash
npm install @avsbhq/solid
```

Solid 1.8 or later is required as a peer dependency. `@solidjs/start` is an optional peer: install it if you use the server helpers.

---

## 2. Quickstart

```tsx
// src/index.tsx
import { render } from 'solid-js/web';
import { AvsbProvider } from '@avsbhq/solid';
import App from './App';

declare const userId: string;

render(
  () => (
    <AvsbProvider
      sdkKey={import.meta.env['VITE_AVSB_SDK_KEY'] as string}
      context={{ kind: 'user', key: userId, plan: 'pro' }}
    >
      <App />
    </AvsbProvider>
  ),
  document.getElementById('root') as HTMLElement,
);
```

```tsx
// src/CheckoutButton.tsx
import { createBoolFlag, createExposure, useTrack } from '@avsbhq/solid';
import type { Accessor, JSX } from 'solid-js';
import type { Flag } from '@avsbhq/solid';

export default function CheckoutButton(): JSX.Element {
  const checkout: Accessor<Flag<boolean>> = createBoolFlag('new_checkout_flow', false);
  const track = useTrack();

  // The visitor is about to see this decision, so record it once.
  createExposure('new_checkout_flow');

  return (
    <button onClick={() => track('checkout_started', { value: 99 })}>
      {checkout().value ? 'Start checkout (new)' : 'Buy now'}
    </button>
  );
}
```

Both provider props matter: without `context` the visitor gets a persisted anonymous id, which is fine for anonymous experiments but cannot target logged-in attributes.

---

## 3. SDK keys

Get the SDK key for the environment you want from your project: **app.avsb.cloud**, then **Environments** in the project sidebar. The format is `sdk_<environment>_<id>`, for example `sdk_production_ttqm0eaj4vth1krcb2xn`.

There is one SDK key per environment, and "SDK key" is its only name. There is no separate client key and server key to choose between.

Your SDK key is a public identifier, not a secret: it is safe to ship in browser and mobile bundles, it can only fetch that environment's flag configuration and send events, and it can never read or change anything in your dashboard.

```
VITE_AVSB_SDK_KEY=sdk_production_...
```

The client checks the shape of the key when it is constructed. A key that does not look like an SDK key (a pasted dashboard URL, a truncated copy, a personal access token or a service token) logs one actionable error naming what it got and where the real key lives.

---

## 4. The whole type surface

Every export, with its real signature. `FlagKeyInput = string | Accessor<string>`, so any read can follow a reactive key.

The signatures name the package's own types, and Solid's `Context`. Both come from here:

```ts
import type {
  AvsbClientOptions,
  AvsbContextValue,
  AvsbProviderProps,
  EvalContext,
  FlagDatafile,
  FlagKeyInput,
  SolidAvsbClient,
  TrackPayload,
  UseAvsbStatusResult,
} from '@avsbhq/solid';
import type { Context } from 'solid-js';
```

```tsx
// Provider
function AvsbProvider(props: AvsbProviderProps): JSX.Element;

// Reading flags
function createFlag<T>(flagKey: FlagKeyInput, defaultValue: T): Accessor<Flag<T>>;
function createFlagValue<T>(flagKey: FlagKeyInput, defaultValue: T): Accessor<T>;
function createBoolFlag(flagKey: FlagKeyInput, defaultValue: boolean): Accessor<Flag<boolean>>;
function createStringFlag(flagKey: FlagKeyInput, defaultValue: string): Accessor<Flag<string>>;
function createNumberFlag(flagKey: FlagKeyInput, defaultValue: number): Accessor<Flag<number>>;
function createJsonFlag<T>(flagKey: FlagKeyInput, defaultValue: T): Accessor<Flag<T>>;
function createAllFlags(): Accessor<Record<string, Flag>>;

// Readiness and errors
function createFlagReady(): Accessor<boolean>;
function useAvsbStatus(): UseAvsbStatusResult;

// Client, identity, events
function useAvsbClient(): SolidAvsbClient;
function useTrack(): (eventKey: string, payload?: TrackPayload) => void;
function useIdentify(): (context: EvalContext) => void;
function useAlias(): (previousContext: EvalContext, newContext: EvalContext) => void;
function useReset(): () => void;
function createExposure(flagKey: FlagKeyInput): void;
function createFlagSubscription(flagKey: FlagKeyInput, callback: (flag: Flag) => void): void;

// Context, for custom providers
const AvsbContext: Context<AvsbContextValue | symbol>;
function useAvsbContext(): AvsbContextValue;
function hasAvsbContext(): boolean;
```

**Naming rule:** `create*` registers something reactive (a signal, an effect, a subscription that is cleaned up with the owner). `use*` reads the provider context and hands back a plain function. That is why exposure is `createExposure` (it schedules work on mount) while tracking is `useTrack` (it just gives you a function).

### Provider props

```tsx
type AvsbProviderProps =
  | (AvsbClientOptions & { children: JSX.Element; client?: never })
  | { client: SolidAvsbClient; children: JSX.Element };
```

**Mode A** (an `sdkKey`, plus any other `AvsbClientOptions` such as `context` or `bootstrap`) means the provider builds the client and closes it on cleanup. **Mode B** (a `client`) means you own its lifetime and the provider never closes it. Passing neither throws while the component is created, with a message naming both fixes, rather than rendering a tree where every flag is silently the default.

### `AvsbContextValue`

```tsx
interface AvsbContextValue {
  client: SolidAvsbClient;
  status: Accessor<'loading' | 'ready' | 'error'>;
  error: Accessor<Error | undefined>;
  degraded: Accessor<boolean>;
}
```

### `Flag<T>`, the return type of every read

```tsx
interface Flag<T = unknown> {
  /** The variation value, typed against the default you passed. */
  readonly value: T;
  /** Variation key, null when the default was served or the flag is unknown. */
  readonly variationKey: string | null;
  /** Why this value was produced. */
  readonly source: EvaluationSource;
  readonly ruleId: string | null;
  readonly ruleType: RuleType | null;
  /** Structured reasons for this decision. Never null; may be empty. */
  readonly reasons: string[];
  readonly evaluatedAt: number;
  readonly durationMicros: number;
  /** A real decision produced a truthy value. */
  isEnabled(): boolean;
  /** False for 'not_found' and for 'not_ready'. */
  exists(): boolean;
}

type RuleType = 'targeted_delivery' | 'ab_test' | 'holdout' | 'bandit';

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

| `source`           | Meaning                                                       | `isEnabled()`   | `exists()` |
| ------------------ | ------------------------------------------------------------- | --------------- | ---------- |
| `datafileOverride` | A per-user override in the dashboard matched.                 | value-dependent | true       |
| `runtimeOverride`  | `setOverrideForUser` or `setGlobalOverride` matched.          | value-dependent | true       |
| `sticky`           | A previously stored assignment was reused.                    | value-dependent | true       |
| `rule`             | A targeting rule or A/B rule matched.                         | value-dependent | true       |
| `holdout`          | The visitor is held out, so the holdout variation was served. | value-dependent | true       |
| `bandit`           | A bandit rule picked the variation.                           | value-dependent | true       |
| `default`          | The flag exists, nothing matched, default variation served.   | false           | true       |
| `disabled`         | The flag exists but is off in this environment.               | false           | true       |
| `not_found`        | The datafile loaded and has no such key. Check the name.      | false           | false      |
| `not_ready`        | No datafile yet. Gate on `createFlagReady()`.                 | false           | false      |

"value-dependent" means `isEnabled()` is `Boolean(flag.value)`.

### `UseAvsbStatusResult`

```tsx
interface UseAvsbStatusResult {
  status: Accessor<'loading' | 'ready' | 'error'>;
  error: Accessor<Error | undefined>;
  degraded: Accessor<boolean>;
}
```

### Typed flag keys

`FlagKeyInput` is built from `string` until you generate your keys. Generate
them and it is built from the union of this project's real flag keys, so a typo
is a compile error and your editor completes the list:

```bash
npx @avsbhq/cli codegen --output src/generated/flags.ts
```

The generated file declares your flags twice on purpose: an importable
`FlagValues` interface for payload types, and a `declare global` block that
teaches every accessor in this package which keys exist. Its important parts:

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
import { createBoolFlag, createJsonFlag } from '@avsbhq/solid';
import type { FlagValues } from './generated/flags';

const checkout = createBoolFlag('checkout_v2', false);

// A JSON flag types its payload from the generated table:
const theme = createJsonFlag<FlagValues['theme']>('theme', { primary: '#111' });

// Once the generated file exists, this line stops compiling:
// 'chekcout_v2' is not a flag key.
const typo = createBoolFlag('chekcout_v2', false);
```

One real consequence for reactive keys: an `Accessor<string>` no longer
satisfies `FlagKeyInput` once your keys are generated, because that accessor
could return any string. Declare it as `Accessor<AvsbFlagKey>` and it fits
again.

Nothing changes for a project that never runs `codegen`: with no generated file
the table is empty, so `FlagKeyInput` accepts any string exactly as it does
today, and every call you have already written compiles unchanged. For a key
computed at runtime, widen deliberately with `key as AvsbFlagKey` (that type is
exported from `@avsbhq/core`).

---

## 5. Reading flags

```tsx
import { createBoolFlag, createJsonFlag, createFlagValue } from '@avsbhq/solid';

interface ApiConfig {
  timeout: number;
  retries: number;
}

const darkMode = createBoolFlag('dark_mode', false);
const config = createJsonFlag<ApiConfig>('api_config', { timeout: 5000, retries: 3 });
const banner = createFlagValue('promo_banner', 'grey');

const timeout: number = config().value.timeout;
```

The typed reads check the value against the type the platform declared for that flag. **On a mismatch nothing throws**: the SDK logs one warning naming the flag and the getter, then returns your `defaultValue` with `source: 'not_found'`. `createJsonFlag<T>` does not validate the shape of `T` at runtime, only that the flag is declared as JSON; validate the payload yourself if it crosses a trust boundary.

A default value is always required, and it is what you get before the SDK is ready or when the key is unknown.

### Reactive keys

```tsx
import { createSignal } from 'solid-js';

const [selected, setSelected] = createSignal('feature_a');
const flag = createFlag(selected, false); // re-subscribes when `selected` changes
```

### Every flag at once

```tsx
const flags = createAllFlags(); // Accessor<Record<string, Flag>>
```

Re-runs on any flag change, so prefer a single-flag accessor in normal components. Exposures are suppressed and the SDK returns the same object between changes, so this is cheap to read in JSX.

---

## 6. Identity

```tsx
import { useAvsbClient, useIdentify, useAlias, useReset } from '@avsbhq/solid';

const client = useAvsbClient();
const identify = useIdentify();
const alias = useAlias();
const reset = useReset();

function onSignIn(user: { id: string; email: string; plan: string }): void {
  const context = client.getContext();
  const anonymousKey: string = 'key' in context ? String(context['key']) : '';

  // Same person, two sessions: this is what lets results stitch them.
  alias({ kind: 'user', key: anonymousKey }, { kind: 'user', key: user.id });

  identify({ kind: 'user', key: user.id, email: user.email, plan: user.plan });
}
```

Anonymous visitors get a persisted id (localStorage, with a cookie fallback), so a returning visitor buckets into the same variation instead of being re-randomised on every load. If the A vs B web snippet is on the same page, the SDK adopts its visitor id so flag exposures and web experiment exposures join to one visitor.

`alias` is synchronous: it queues one event and returns. There is nothing to await, and it does not rewrite assignments already made. `reset()` rotates to a new anonymous identity and clears runtime overrides; call it on sign-out.

### Multi-context

```tsx
identify({
  kind: 'multi',
  user: { kind: 'user', key: 'u_123', plan: 'pro' },
  organization: { kind: 'organization', key: 'org_456', tier: 'enterprise' },
});
```

A rule can bucket on `user.key` while matching an audience condition on `organization.tier`.

---

## 7. Exposures: what lands in your results

Reads never record an exposure. That is deliberate: an exposure means "this visitor saw this decision", and a component can re-run for reasons that have nothing to do with the visitor.

```tsx
import { createExposure } from '@avsbhq/solid';

// In the component that actually shows the variation:
createExposure('new_checkout_flow');
```

`createExposure` fires on mount, once, or as soon as the SDK becomes ready if it is not yet. It is also what makes a server-rendered variant visible in results: if the value arrived as a prop from the server, call `createExposure` where it is rendered.

Only decisions that belong in an experiment (A/B rules, holdouts, bandits) produce an exposure event; a plain rollout has nothing to record.

For side effects that are not rendering:

```tsx
createFlagSubscription('new_checkout_flow', (flag) => {
  analytics.track('checkout_variant_assigned', { variationKey: flag.variationKey });
});
```

---

## 8. Readiness and failure

```tsx
import { useAvsbStatus } from '@avsbhq/solid';
import { Show } from 'solid-js';

function Gate(): JSX.Element {
  const { status, error, degraded } = useAvsbStatus();

  return (
    <Show when={status() !== 'loading'} fallback={<Skeleton />}>
      <Show when={degraded()}>
        <StaleDataNotice message={error()?.message} />
      </Show>
      <App />
    </Show>
  );
}
```

- `'loading'`: no datafile yet and nothing cached.
- `'ready'`: flags answer. A **degraded** client is ready: a refresh failed while a cached datafile is being served, so values work and may be stale. `error()` says why.
- `'error'`: nothing could be loaded. Every flag returns the default you passed, and `error()?.message` names the HTTP status, the URL tried, and the fix.

The SDK's default logger writes to the console at `warn` level in development and is silent in production. Pass `logLevel="silent"` (or any other `AvsbClientOptions` field) to the provider to change that.

---

## 9. SolidStart

```tsx
// src/middleware.ts
import { createMiddleware } from '@solidjs/start/middleware';
import { AvsbServer } from '@avsbhq/node';
import { withAvsbServerContext } from '@avsbhq/solid/solid-start';

const avsb = new AvsbServer({ sdkKey: process.env['AVSB_SDK_KEY'] ?? '' });

export default createMiddleware({
  onRequest: [
    withAvsbServerContext(() => {}, {
      serverClient: avsb,
      resolveContext: (event) => ({
        kind: 'user',
        key: event.request.headers.get('x-user-id') ?? 'anonymous',
      }),
    }),
  ],
});
```

The inner handler returns nothing, on purpose. On the runner underneath SolidStart, an `onRequest` handler that returns a value is taken as the response for that request, so returning the event would short-circuit the route it was meant to pass through. Return a `Response` only when you mean to answer the request yourself.

```tsx
import type {
  AvsbBoundClient,
  AvsbServerContextOptions,
  SolidStartEvent,
} from '@avsbhq/solid/solid-start';

interface AvsbServerLocals {
  avsbContext: EvalContext | null;
  avsbClient: AvsbBoundClient | null;
  avsbBootstrap: FlagDatafile | null;
}

interface AvsbServerClient {
  forUser(context: EvalContext): AvsbBoundClient;
  getDatafile(): FlagDatafile | null;
}

/** Pass the request through (return nothing) or answer it (return a Response). */
type SolidStartHandler = (event: SolidStartEvent) => void | Response | Promise<void | Response>;

function withAvsbServerContext(
  handler: SolidStartHandler,
  options: AvsbServerContextOptions,
): SolidStartHandler;
function getAvsbBootstrap(serverClient: AvsbServerClient): FlagDatafile | null;
```

`AvsbServer` from `@avsbhq/node` satisfies `AvsbServerClient`, and the client its `forUser(context)` returns satisfies `AvsbBoundClient`, so nothing needs casting.

Read flags on the server from `event.locals.avsbClient`, and pass `event.locals.avsbBootstrap` into the page so the client provider starts ready:

```tsx
declare const PUBLIC_SDK_KEY: string;
declare const bootstrapFromServer: FlagDatafile;

function Root(): JSX.Element {
  return (
    <AvsbProvider sdkKey={PUBLIC_SDK_KEY} bootstrap={bootstrapFromServer}>
      <App />
    </AvsbProvider>
  );
}
```

**What changed and why**: the previous helper took an `sdkKey` it never used, set `locals.avsbBootstrap = null` with a comment saying something else would fill it in (nothing did), and its `serializeAvsbBootstrap` cast a map of evaluated flags to `FlagDatafile`, which crashed the browser client at construction. `avsbBootstrap` is now the datafile, which is JSON-safe by construction because it is the document the CDN serves. Handing the browser server-evaluated VALUES instead is a different handoff that the browser SDK does not expose publicly yet.

---

## 10. Packaging

The `solid` export condition points at TypeScript source (`./src/index.ts`), which is what Solid libraries are supposed to ship: `vite-plugin-solid` compiles the JSX with your app's own settings, so there is one reactive runtime and one JSX transform. The bundled `dist` output is the fallback for toolchains that do not understand the condition.

The package used to declare `"solid": "./dist/index.jsx"`, a file the build never emitted, so every toolchain that honoured the condition got a missing file and everything else got esbuild-compiled JSX, which is exactly the setup Solid libraries are told to avoid.

---

## 11. One provider, please

Nesting a second `<AvsbProvider>` inside another shadows the outer one for everything below it: two clients, two visitor ids, two event queues, and identify calls that only reach one of them. The provider logs a warning in development when it detects this. Mount one provider at the root unless you deliberately want an isolated subtree.

---

## 12. Graceful shutdown

Mode A closes the client when the provider's owner is disposed, which flushes queued events. In Mode B you own it:

```tsx
import { onCleanup } from 'solid-js';

onCleanup(() => {
  void client.close(); // flushes internally
});
```

---

## 13. Testing

```tsx
import { render } from '@solidjs/testing-library';
import { AvsbTestProvider } from '@avsbhq/solid/testing';

render(() => (
  <AvsbTestProvider flags={{ 'checkout_v2': true }}>
    <CheckoutButton />
  </AvsbTestProvider>
));
```

`AvsbTestProvider` is the real `<AvsbProvider>` in Mode B around a real `AvsbClient` whose datafile is built from your flags map, with the network, the cache, and logging switched off. Components under test use the same accessors, the same evaluator, and the same exposure rules they use in production.

Drive the client directly when that is simpler:

```tsx
import { createTestClient, createTestDatafile } from '@avsbhq/solid/testing';

const client = createTestClient({ flags: { 'checkout_v2': true } });
expect(client.getBoolFlag('checkout_v2', false).isEnabled()).toBe(true);

// Publish a new datafile and watch subscribers wake up.
client.applyDatafileBootstrap(
  createTestDatafile({ 'checkout_v2': false }, { publishedAt: '2024-06-01T00:00:00.000Z' }),
);
```

```tsx
import type { AvsbClient } from '@avsbhq/browser';

/** Flag key to the value it serves. */
type TestFlags = Record<string, boolean | string | number | object | null>;

interface TestClientOptions {
  flags?: TestFlags;
  context?: EvalContext;
  /** A full datafile, for when a map of values is not expressive enough. */
  datafile?: FlagDatafile;
}

function createTestClient(options?: TestClientOptions): AvsbClient;
function createTestDatafile(flags?: TestFlags, options?: { publishedAt?: string }): FlagDatafile;

interface AvsbTestProviderProps {
  flags?: TestFlags;
  context?: EvalContext;
  client?: SolidAvsbClient;
  children: JSX.Element;
}
```

Each entry in `flags` becomes a fully rolled out flag, so `isEnabled()` is true for truthy values and reads record exposures exactly as an A/B rule would. Call `client.close()` at the end of a test that tracked events, so the flush timer does not outlive it.

---

## 14. Migration from LaunchDarkly

| LaunchDarkly JS                      | `@avsbhq/solid`                                    |
| ------------------------------------ | -------------------------------------------------- |
| `initialize(clientId, context)`      | `<AvsbProvider sdkKey context>`                    |
| `client.waitForInitialization()`     | `createFlagReady()` or `useAvsbStatus()`           |
| `client.allFlags()`                  | `createAllFlags()`                                 |
| `client.variation('key', false)`     | `createBoolFlag('key', false)().value`             |
| `client.variationDetail('key', d)`   | `createFlag('key', d)()`                           |
| `client.identify(context)`           | `useIdentify()(context)`                           |
| `client.track('event', data, value)` | `useTrack()('event', { value, properties: data })` |
| `client.on('change:key', cb)`        | `createFlagSubscription('key', cb)`                |

Differences worth knowing:

- Every read returns a `Flag<T>` object, not a raw value, so you get the decision metadata without a second call.
- Every read requires an explicit default. There is no untyped variation call.
- Multi-context is first class: one `EvalContext` with kinds, no wrapper type.
- Reads record no exposure. Call `createExposure(key)` where the visitor actually sees the decision.

---

## 15. Set this up with your AI assistant

Paste this into Claude Code, Cursor, or any coding assistant:

```text
Set up A vs B feature flags in this Solid project.

1. Run: npx @avsbhq/cli init
   Use my saved CLI login: do not ask me for a token and do not put one in any file.
   It detects Solid, writes the SDK key into the environment file this project's
   bundler reads (VITE_AVSB_SDK_KEY for Vite), and writes an example component.
2. Install @avsbhq/solid with this project's package manager.
3. Mount <AvsbProvider> once at the root with that key and a context of
   { kind: 'user', key: <your user id> }, then read the flag the example names.
4. Reads are accessors over a Flag object, so call flag().value or
   flag().isEnabled(), and always pass a fallback. Reading a flag records nothing:
   call createExposure(key) where the variation is shown.
5. Then run: npx @avsbhq/cli codegen

Done looks like: the app starts, the flag reads without throwing, and avsb init
prints the line confirming it saw the first check-in.
```

`avsb init` ends by waiting for your app's first check-in and printing what it
saw, so the terminal tells you it works rather than the dashboard.
