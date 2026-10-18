# @avsbhq/svelte

Svelte 5 and SvelteKit SDK for the [A vs B](https://app.avsb.cloud) platform.

Mount one `<AvsbProvider>`, then read feature flags with stores (`$flag`) or with runes (`flag.current`). Built on [`@avsbhq/browser`](https://www.npmjs.com/package/@avsbhq/browser): components update when a flag's value changes, and only the ones reading that flag.

---

## 1. Install

```bash
npm install @avsbhq/svelte
```

Svelte 5 or later is required as a peer dependency. `@sveltejs/kit` is an optional peer: install it if you use the server helpers.

---

## 2. Quickstart

```svelte
<!-- src/routes/+layout.svelte -->
<script lang="ts">
  import AvsbProvider from '@avsbhq/svelte/AvsbProvider.svelte'
  import { PUBLIC_AVSB_SDK_KEY } from '$env/static/public'

  let { data, children } = $props()
</script>

<AvsbProvider
  sdkKey={PUBLIC_AVSB_SDK_KEY}
  context={{ kind: 'user', key: data.userId }}
  bootstrap={data.avsbBootstrap}
>
  {@render children()}
</AvsbProvider>
```

```svelte
<!-- CheckoutButton.svelte -->
<script lang="ts">
  import { boolFlag, getTrack, getExposure } from '@avsbhq/svelte'
  import { onMount } from 'svelte'

  const checkout = boolFlag('new_checkout_flow', false)
  const track = getTrack()
  const expose = getExposure()

  // The visitor is about to see this decision, so record it once.
  onMount(() => expose('new_checkout_flow'))
</script>

<button onclick={() => track('checkout_started', { value: 99 })}>
  {$checkout.value ? 'Start checkout (new)' : 'Buy now'}
</button>
```

Both provider props matter: without `context` the visitor gets a persisted anonymous id, which is fine for anonymous experiments but cannot target logged-in attributes.

---

## 3. SDK keys

Get the SDK key for the environment you want from your project: **app.avsb.cloud**, then **Environments** in the project sidebar. The format is `sdk_<environment>_<id>`, for example `sdk_production_ttqm0eaj4vth1krcb2xn`.

There is one SDK key per environment, and "SDK key" is its only name. There is no separate client key and server key to choose between.

Your SDK key is a public identifier, not a secret: it is safe to ship in browser and mobile bundles, it can only fetch that environment's flag configuration and send events, and it can never read or change anything in your dashboard.

That is why the SvelteKit example above reads it from `$env/static/public`.

The client checks the shape of the key when it is constructed. A key that does not look like an SDK key (a pasted dashboard URL, a truncated copy, a personal access token or a service token) logs one actionable error naming what it got and where the real key lives.

---

## 4. The whole type surface

Every export, with its real signature. Every store factory takes an optional `ctx` as its last argument: omit it inside a component, pass it anywhere else.

The signatures name the package's own types, and Svelte's store type. Both come from here:

```ts
import type {
  AvsbClientOptions,
  AvsbContextValue,
  AvsbProviderProps,
  AvsbStatusValue,
  EvalContext,
  Flag,
  FlagDatafile,
  SvelteAvsbClient,
  TrackPayload,
} from '@avsbhq/svelte';
import type { Readable } from 'svelte/store';
```

```ts
// Provider
function createAvsbContext(options: AvsbProviderProps): CreateAvsbContextResult;
function buildAvsbContext(options: AvsbProviderProps): CreateAvsbContextResult;

interface CreateAvsbContextResult {
  contextValue: AvsbContextValue;
  client: SvelteAvsbClient;
  cleanup: () => void;
}

// Reading flags
function flag<T>(flagKey: string, defaultValue: T, ctx?: AvsbContextValue): Readable<Flag<T>>;
function flagValue<T>(flagKey: string, defaultValue: T, ctx?: AvsbContextValue): Readable<T>;
function boolFlag(
  flagKey: string,
  defaultValue: boolean,
  ctx?: AvsbContextValue,
): Readable<Flag<boolean>>;
function stringFlag(
  flagKey: string,
  defaultValue: string,
  ctx?: AvsbContextValue,
): Readable<Flag<string>>;
function numberFlag(
  flagKey: string,
  defaultValue: number,
  ctx?: AvsbContextValue,
): Readable<Flag<number>>;
function jsonFlag<T>(flagKey: string, defaultValue: T, ctx?: AvsbContextValue): Readable<Flag<T>>;
function allFlags(ctx?: AvsbContextValue): Readable<Record<string, Flag>>;

// Readiness and errors
function flagReady(ctx?: AvsbContextValue): Readable<boolean>;
function avsbStatus(ctx?: AvsbContextValue): Readable<AvsbStatusValue>;

// Client, identity, events
function getAvsbClient(ctx?: AvsbContextValue): SvelteAvsbClient;
function getTrack(ctx?: AvsbContextValue): (eventKey: string, payload?: TrackPayload) => void;
function getIdentify(ctx?: AvsbContextValue): (context: EvalContext) => void;
function getAlias(ctx?: AvsbContextValue): (previous: EvalContext, next: EvalContext) => void;
function getReset(ctx?: AvsbContextValue): () => void;
function getExposure(ctx?: AvsbContextValue): (flagKey: string) => () => void;
function subscribeFlag(
  flagKey: string,
  callback: (flag: Flag) => void,
  ctx?: AvsbContextValue,
): () => void;

// Context
const AVSB_CONTEXT_KEY: unique symbol;
function useAvsbContext(): AvsbContextValue;
function setAvsbContext(value: AvsbContextValue): void;
function hasAvsbContext(): boolean;
```

The `get*` prefix is not decoration: Svelte context can only be read while a component is initialising, so these are called at the top of `<script>` and return a function you can use later, in a handler or in `onMount`.

### Provider props

```ts
type AvsbProviderProps = (AvsbClientOptions & { client?: never }) | { client: SvelteAvsbClient };
```

**Mode A** (an `sdkKey`, plus any other `AvsbClientOptions` such as `context` or `bootstrap`) means the provider builds the client and closes it when the component is destroyed. **Mode B** (a `client`) means you own its lifetime and the provider never closes it. Passing neither throws during initialisation with a message naming both fixes, rather than rendering a tree where every flag is silently the default.

### `AvsbContextValue`

```ts
interface AvsbContextValue {
  client: SvelteAvsbClient;
  readonly status: 'loading' | 'ready' | 'error';
  readonly error: Error | undefined;
  readonly degraded: boolean;
  onStatusChange(listener: () => void): () => void;
}
```

### `Flag<T>`, the return type of every read

```ts
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
| `not_ready`        | No datafile yet. Gate on `$flagReady`.                        | false           | false      |

"value-dependent" means `isEnabled()` is `Boolean(flag.value)`.

### `AvsbStatusValue`

```ts
interface AvsbStatusValue {
  status: 'loading' | 'ready' | 'error';
  error: Error | undefined;
  degraded: boolean;
}
```

### Typed flag keys

Every `flagKey` above is `string` until you generate your keys. Generate them
and it becomes the union of this project's real flag keys, so a typo is a
compile error and your editor completes the list:

```bash
npx @avsbhq/cli codegen --output src/generated/flags.ts
```

The generated file declares your flags twice on purpose: an importable
`FlagValues` interface for payload types, and a `declare global` block that
teaches every store, rune and action in this package which keys exist. Its
important parts:

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

```svelte
<script lang="ts">
  import { boolFlag, jsonFlag } from '@avsbhq/svelte'
  import type { FlagValues } from './generated/flags'

  const checkout = boolFlag('checkout_v2', false)

  // A JSON flag types its payload from the generated table:
  const theme = jsonFlag<FlagValues['theme']>('theme', { primary: '#111' })

  // Once the generated file exists, this line stops compiling:
  // 'chekcout_v2' is not a flag key.
  const typo = boolFlag('chekcout_v2', false)
</script>
```

The runes layer (`flagState`, `boolFlagState` and friends) and the SvelteKit
server client narrow their keys the same way.

Nothing changes for a project that never runs `codegen`: with no generated file
the table is empty, every `flagKey` is exactly `string`, and every call you have
already written compiles unchanged. For a key computed at runtime, widen
deliberately with `key as AvsbFlagKey` (that type is exported from
`@avsbhq/core`).

---

## 5. Runes, if you prefer them

```svelte
<script lang="ts">
  import { boolFlagState } from '@avsbhq/svelte/runes'

  const checkout = boolFlagState('new_checkout_flow', false)
</script>

{#if checkout.current.value}
  <NewCheckout />
{/if}
```

```ts
function flagState<T>(flagKey: string, defaultValue: T, ctx?: AvsbContextValue): FlagState<T>;
function boolFlagState(
  flagKey: string,
  defaultValue: boolean,
  ctx?: AvsbContextValue,
): FlagState<boolean>;
function stringFlagState(
  flagKey: string,
  defaultValue: string,
  ctx?: AvsbContextValue,
): FlagState<string>;
function numberFlagState(
  flagKey: string,
  defaultValue: number,
  ctx?: AvsbContextValue,
): FlagState<number>;
function jsonFlagState<T>(flagKey: string, defaultValue: T, ctx?: AvsbContextValue): FlagState<T>;
function allFlagsState(ctx?: AvsbContextValue): { readonly current: Record<string, Flag> };
function avsbStatusState(ctx?: AvsbContextValue): { readonly current: AvsbStatusValue };

interface FlagState<T> {
  readonly current: Flag<T>;
}
```

The two layers are the same subscription underneath, so they can never report different values. Pick per file: stores if your codebase is store-shaped, runes if it is runes-shaped.

**Where they can be called.** Anywhere an effect can be created: a component's `<script>`, or a `.svelte.ts` module or class that a component instantiates. Called from a plain module at import time you get the first value and no updates, because `$effect` needs an owner. For that case, own it yourself:

```ts
declare const ctx: AvsbContextValue;
declare function report(isEnabled: boolean): void;

const stop = $effect.root(() => {
  const checkout = boolFlagState('new_checkout_flow', false, ctx);
  $effect(() => report(checkout.current.value));
});
// later
stop();
```

Passing `ctx` covers the provider context, not the effect owner: those are two separate requirements, and only the stores are free of the second one.

`@avsbhq/svelte/runes` ships as TypeScript source rather than compiled output, because runes have to be compiled by your app's Svelte compiler. That is why it is a separate entry point: importing the main barrel never pulls uncompiled runes into a non-Svelte build.

---

## 6. Identity

```svelte
<script lang="ts">
  import { getAvsbClient, getIdentify, getAlias, getReset } from '@avsbhq/svelte'

  const client = getAvsbClient()
  const identify = getIdentify()
  const alias = getAlias()
  const reset = getReset()

  function onSignIn(user: { id: string; email: string; plan: string }): void {
    const context = client.getContext()
    const anonymousKey = 'key' in context ? String(context['key']) : ''

    // Same person, two sessions: this is what lets results stitch them.
    alias({ kind: 'user', key: anonymousKey }, { kind: 'user', key: user.id })

    identify({ kind: 'user', key: user.id, email: user.email, plan: user.plan })
  }
</script>
```

Anonymous visitors get a persisted id (localStorage, with a cookie fallback), so a returning visitor buckets into the same variation instead of being re-randomised on every load. If the A vs B web snippet is on the same page, the SDK adopts its visitor id so flag exposures and web experiment exposures join to one visitor.

`alias` is synchronous: it queues one event and returns. There is nothing to await, and it does not rewrite assignments already made. `reset()` rotates to a new anonymous identity and clears runtime overrides; call it on sign-out.

### Multi-context

```ts
import { getIdentify } from '@avsbhq/svelte';

// At the top of a component's <script>, as above.
const identify = getIdentify();

identify({
  kind: 'multi',
  user: { kind: 'user', key: 'u_123', plan: 'pro' },
  organization: { kind: 'organization', key: 'org_456', tier: 'enterprise' },
});
```

A rule can bucket on `user.key` while matching an audience condition on `organization.tier`.

---

## 7. Reading flags

```svelte
<script lang="ts">
  import { boolFlag, jsonFlag, flagValue } from '@avsbhq/svelte'

  interface ApiConfig {
    timeout: number
    retries: number
  }

  const darkMode = boolFlag('dark_mode', false)
  const config = jsonFlag<ApiConfig>('api_config', { timeout: 5000, retries: 3 })
  const banner = flagValue('promo_banner', 'grey')
</script>

<Theme dark={$darkMode.value} timeout={$config.value.timeout} colour={$banner} />
```

The typed reads check the value against the type the platform declared for that flag. **On a mismatch nothing throws**: the SDK logs one warning naming the flag and the getter, then returns your `defaultValue` with `source: 'not_found'`. `jsonFlag<T>` does not validate the shape of `T` at runtime, only that the flag is declared as JSON; validate the payload yourself if it crosses a trust boundary.

A default value is always required, and it is what you get before the SDK is ready or when the key is unknown.

`allFlags()` gives you everything at once for debug panels; prefer the single-flag stores in normal components, since `allFlags` re-emits on any change.

---

## 8. Exposures: what lands in your results

Reading a flag never records an exposure. That is deliberate: an exposure means "this visitor saw this decision", and a component can re-render for reasons that have nothing to do with the visitor.

```svelte
<script lang="ts">
  import { getExposure } from '@avsbhq/svelte'
  import { onMount } from 'svelte'

  const expose = getExposure()
  onMount(() => expose('new_checkout_flow'))
</script>
```

If the SDK is not ready yet the exposure is deferred to the moment it is, rather than dropped. Only decisions that belong in an experiment (A/B rules, holdouts, bandits) produce an event; a plain rollout has nothing to record.

`expose(key)` returns a cancel function for that deferred case, and `onMount` hands whatever you return to `onDestroy`, so the one-liner above already cancels itself: a component destroyed before the SDK was ready does not record an exposure for a decision nobody is looking at any more.

This is also how a server-rendered variant becomes visible in results: evaluate on the server, render the value, and call `expose(key)` in the component that shows it. On the server side, `locals.avsb?.client.manualExposure(key)` does the same job when the page is rendered without hydration.

For side effects that are not rendering:

```ts
import { onDestroy } from 'svelte';

onDestroy(
  subscribeFlag('new_checkout_flow', (f) => {
    analytics.track('checkout_variant_assigned', { variationKey: f.variationKey });
  }),
);
```

---

## 9. Readiness and failure

```svelte
<script lang="ts">
  import { avsbStatus } from '@avsbhq/svelte'
  const status = avsbStatus()
</script>

{#if $status.status === 'loading'}
  <Skeleton />
{:else}
  {#if $status.degraded}
    <StaleDataNotice message={$status.error?.message} />
  {/if}
  <App />
{/if}
```

- `'loading'`: no datafile yet and nothing cached.
- `'ready'`: flags answer. A **degraded** client is ready: a refresh failed while a cached datafile is being served, so values work and may be stale. `error` says why.
- `'error'`: nothing could be loaded. Every flag returns the default you passed, and `error.message` names the HTTP status, the URL tried, and the fix.

The SDK's default logger writes to the console at `warn` level in development and is silent in production. Pass `logLevel="silent"` (or any other `AvsbClientOptions` field) to the provider to change that.

---

## 10. SvelteKit

```ts
// src/hooks.server.ts
import { AvsbServer } from '@avsbhq/node';
import { withAvsbHooks } from '@avsbhq/svelte/sveltekit';
import { AVSB_SDK_KEY } from '$env/static/private';
import type { Handle } from '@sveltejs/kit';

const avsb = new AvsbServer({ sdkKey: AVSB_SDK_KEY });

export const handle: Handle = withAvsbHooks(({ event, resolve }) => resolve(event), {
  serverClient: avsb,
  resolveContext: (event) => ({
    kind: 'user',
    key: event.cookies.get('uid') ?? 'anonymous',
  }),
});
```

`withAvsbHooks` takes and returns SvelteKit's own `Handle`, so it drops straight into `hooks.server.ts` with no cast and composes with `sequence()` in either order.

```ts
// src/app.d.ts
declare global {
  namespace App {
    interface Locals {
      // Optional: `withAvsbHooks` sets no locals on a request whose
      // `resolveContext` returned null. Make it required only if yours
      // never does.
      avsb?: import('@avsbhq/svelte/sveltekit').AvsbLocals;
    }
  }
}
export {};
```

```ts
// src/routes/+layout.server.ts
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }: { locals: App.Locals }) => ({
  // The datafile: this is what <AvsbProvider bootstrap={...}> takes.
  avsbBootstrap: locals.avsb?.bootstrap ?? null,
  // Server-evaluated values, if you want the markup decided on the server.
  newCheckout: locals.avsb?.client.getBoolFlag('new_checkout_flow', false).value ?? false,
});
```

Then pass `data.avsbBootstrap` to the provider, as in the quickstart. With a bootstrap the browser client is ready on the first render: `$flagReady` is already `true`, no loading state renders, and the values match what the server rendered.

```ts
import type { AvsbBoundClient, RequestEvent } from '@avsbhq/svelte/sveltekit';

interface AvsbLocals {
  evalContext: EvalContext;
  client: AvsbBoundClient;
  bootstrap: FlagDatafile | null;
}

interface AvsbServerClient {
  forUser(context: EvalContext): AvsbBoundClient;
  getDatafile(): FlagDatafile | null;
}

interface WithAvsbHooksOptions {
  serverClient: AvsbServerClient;
  /** Return null to skip A vs B for this request; no locals are set. */
  resolveContext: (event: RequestEvent) => EvalContext | null;
}

// `Handle` and `RequestEvent` are SvelteKit's own types, re-exported here.
function withAvsbHooks(handle: Handle, options: WithAvsbHooksOptions): Handle;
function getAvsbBootstrap(serverClient: AvsbServerClient): FlagDatafile | null;
function bindAvsbClient(serverClient: AvsbServerClient, context: EvalContext): AvsbBoundClient;
```

`AvsbServer` from `@avsbhq/node` satisfies `AvsbServerClient`, and the client its `forUser(context)` returns satisfies `AvsbBoundClient`, so nothing needs casting.

**What changed and why**: the previous helper serialised a map of evaluated flags and told you to pass it as `bootstrap`. The browser client's `bootstrap` is a datafile and it iterates `datafile.flags`, so following that recipe crashed the client at construction. `bootstrap` is now the datafile, which is JSON-safe by construction because it is the document the CDN serves. Handing the browser server-evaluated VALUES instead is a different handoff that the browser SDK does not expose publicly yet.

---

## 11. One provider, please

Nesting a second `<AvsbProvider>` inside another shadows the outer one for everything below it: two clients, two visitor ids, two event queues, and identify calls that only reach one of them. The provider logs a warning in development when it detects this. Mount one provider at the root unless you deliberately want an isolated subtree.

---

## 12. Graceful shutdown

Mode A closes the client when the provider is destroyed, which flushes queued events. In Mode B you own it:

```ts
import { onDestroy } from 'svelte';
import { getAvsbClient } from '@avsbhq/svelte';

const client = getAvsbClient();

onDestroy(async () => {
  await client.close(); // flushes internally
});
```

---

## 13. Testing

```ts
import {
  createTestContextValue,
  createTestClient,
  createTestDatafile,
} from '@avsbhq/svelte/testing';
import { boolFlag } from '@avsbhq/svelte';
import { get } from 'svelte/store';

const { contextValue, client } = createTestContextValue({
  flags: { 'checkout_v2': true },
});

expect(get(boolFlag('checkout_v2', false, contextValue)).isEnabled()).toBe(true);

// Publish a new datafile and watch subscribers wake up.
client.applyDatafileBootstrap(
  createTestDatafile({ 'checkout_v2': false }, { publishedAt: '2024-06-01T00:00:00.000Z' }),
);
```

Inside a component test, set the real context instead:

```ts
import { createAvsbTestContext } from '@avsbhq/svelte/testing';

// during component initialisation
createAvsbTestContext({ flags: { 'checkout_v2': true } });
```

```ts
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
function createTestContextValue(options?: TestClientOptions): CreateAvsbContextResult;
function createAvsbTestContext(options?: TestClientOptions): CreateAvsbContextResult;
function createTestDatafile(flags?: TestFlags, options?: { publishedAt?: string }): FlagDatafile;
```

The client is a real `AvsbClient` whose datafile is built from your flags map, with the network, the cache, and logging switched off, so tests exercise the same evaluator and the same exposure rules as production. Each entry in `flags` becomes a fully rolled out flag, so `isEnabled()` is true for truthy values and reads record exposures exactly as an A/B rule would.

Call `client.close()` at the end of a test that tracked events, so the flush timer does not outlive it.

---

## 14. Migration from LaunchDarkly

| LaunchDarkly JS                      | `@avsbhq/svelte`                                   |
| ------------------------------------ | -------------------------------------------------- |
| `initialize(clientId, context)`      | `<AvsbProvider sdkKey context>`                    |
| `client.waitForInitialization()`     | `$flagReady` or `$avsbStatus`                      |
| `client.allFlags()`                  | `$allFlags`                                        |
| `client.variation('key', false)`     | `$boolFlag('key', false).value`                    |
| `client.variationDetail('key', d)`   | `$flag('key', d)`                                  |
| `client.identify(context)`           | `getIdentify()(context)`                           |
| `client.track('event', data, value)` | `getTrack()('event', { value, properties: data })` |
| `client.on('change:key', cb)`        | `subscribeFlag('key', cb)`                         |

Differences worth knowing:

- Every read returns a `Flag<T>` object, not a raw value, so you get the decision metadata without a second call.
- Every read requires an explicit default. There is no untyped variation call.
- Multi-context is first class: one `EvalContext` with kinds, no wrapper type.
- Reads record no exposure. Call `getExposure()(key)` where the visitor actually sees the decision.

---

## 15. Set this up with your AI assistant

Paste this into Claude Code, Cursor, or any coding assistant:

```text
Set up A vs B feature flags in this Svelte project.

1. Run: npx @avsbhq/cli init
   Use my saved CLI login: do not ask me for a token and do not put one in any file.
   It detects Svelte, writes the SDK key into .env as PUBLIC_AVSB_SDK_KEY for
   SvelteKit (VITE_AVSB_SDK_KEY for plain Vite), and writes an example component.
2. Install @avsbhq/svelte with this project's package manager.
3. Mount AvsbProvider once in the root layout with that key and a context of
   { kind: 'user', key: <your user id> }, then read the flag the example names.
4. Flag stores hold a Flag object, so read $flag.value or call $flag.isEnabled(),
   and always pass a fallback. Reading a flag records nothing: call
   getExposure()(key) where the variation is shown.
5. Then run: npx @avsbhq/cli codegen

Done looks like: the app starts, the flag reads without throwing, and avsb init
prints the line confirming it saw the first check-in.
```

`avsb init` ends by waiting for your app's first check-in and printing what it
saw, so the terminal tells you it works rather than the dashboard.
