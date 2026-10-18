# @avsbhq/vue

Vue 3 SDK for the [A vs B](https://app.avsb.cloud) platform.

Mount one `<AvsbProvider>` (or install `AvsbPlugin`), then read feature flags anywhere with composables. Built on [`@avsbhq/browser`](https://www.npmjs.com/package/@avsbhq/browser): components update when a flag's value changes, and only the components reading that flag.

---

## 1. Install

```bash
npm install @avsbhq/vue
```

Vue 3.4 or later is required as a peer dependency. `pinia` is an optional peer: install it only if you import `@avsbhq/vue/pinia`.

---

## 2. Quickstart

```vue
<!-- App.vue -->
<script setup lang="ts">
import { AvsbProvider } from '@avsbhq/vue';

const sdkKey: string = import.meta.env['VITE_AVSB_SDK_KEY'] as string;
const userId = 'u_123';
</script>

<template>
  <AvsbProvider :sdk-key="sdkKey" :context="{ kind: 'user', key: userId, plan: 'pro' }">
    <RouterView />
  </AvsbProvider>
</template>
```

```vue
<!-- CheckoutButton.vue -->
<script setup lang="ts">
import { useBoolFlag, useExposure, useTrack } from '@avsbhq/vue';
import type { ComputedRef } from 'vue';
import type { Flag } from '@avsbhq/vue';

// Keep the ref: reading `.value` here instead would freeze the first value.
const newCheckout: ComputedRef<Flag<boolean>> = useBoolFlag('new_checkout_flow', false);
const track = useTrack();

// The visitor is about to see this decision, so record it once.
useExposure('new_checkout_flow');
</script>

<template>
  <button @click="track('checkout_started', { value: 99 })">
    {{ newCheckout.value ? 'Start checkout (new)' : 'Buy now' }}
  </button>
</template>
```

Both props matter: without `context` the visitor gets a persisted anonymous id, which is fine for anonymous experiments but cannot target logged-in attributes.

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

Every export, with its real signature. The signatures name the package's own types, and Vue's. Both come from here:

```ts
import type {
  AvsbClientOptions,
  AvsbContextValue,
  AvsbPluginOptions,
  AvsbProviderProps,
  EvalContext,
  Flag,
  FlagDatafile,
  FlagKeyInput,
  TrackPayload,
  UseAvsbStatusResult,
  VueAvsbClient,
} from '@avsbhq/vue';
import type { ComputedRef, DefineComponent, InjectionKey, Plugin } from 'vue';
```

```ts
// Provider and plugin
const AvsbProvider: DefineComponent<AvsbProviderProps>;
const AvsbPlugin: Plugin<AvsbPluginOptions>;

// Reading flags. `FlagKeyInput = string | Ref<string> | ComputedRef<string>`
function useFlag<T>(flagKey: FlagKeyInput, defaultValue: T): ComputedRef<Flag<T>>;
function useFlagValue<T>(flagKey: FlagKeyInput, defaultValue: T): ComputedRef<T>;
function useBoolFlag(flagKey: FlagKeyInput, defaultValue: boolean): ComputedRef<Flag<boolean>>;
function useStringFlag(flagKey: FlagKeyInput, defaultValue: string): ComputedRef<Flag<string>>;
function useNumberFlag(flagKey: FlagKeyInput, defaultValue: number): ComputedRef<Flag<number>>;
function useJsonFlag<T>(flagKey: FlagKeyInput, defaultValue: T): ComputedRef<Flag<T>>;
function useAllFlags(): ComputedRef<Record<string, Flag>>;

// Readiness and errors
function useFlagReady(): ComputedRef<boolean>;
function useAvsbStatus(): UseAvsbStatusResult;

// Identity
function useIdentify(): (context: EvalContext) => void;
function useAlias(): (previousContext: EvalContext, newContext: EvalContext) => void;
function useReset(): () => void;

// Events
function useTrack(): (eventKey: string, payload?: TrackPayload) => void;
function useExposure(flagKey: FlagKeyInput): void;
function useFlagSubscription(flagKey: FlagKeyInput, callback: (flag: Flag) => void): void;

// The client itself
function useAvsbClient(): VueAvsbClient;

// Context, for custom providers
const AvsbInjectionKey: InjectionKey<AvsbContextValue>;
```

### Provider props

```ts
type AvsbProviderProps = AvsbProviderModeAProps | AvsbProviderModeBProps;

interface AvsbProviderModeAProps {
  /** SDK key for the environment you are targeting. */
  sdkKey: string;
  /** Evaluation context. Omit for an anonymous, persisted visitor id. */
  context?: EvalContext;
  /** A datafile fetched on the server, so the first paint has real values. */
  bootstrap?: FlagDatafile;
  /** Everything else AvsbClient accepts (polling, logging, caching). */
  options?: Omit<AvsbClientOptions, 'sdkKey' | 'context' | 'bootstrap'>;
  client?: never;
}

interface AvsbProviderModeBProps {
  /** A client you built and own. The provider will not close it. */
  client: VueAvsbClient;
  sdkKey?: never;
}
```

In templates the props are kebab-case and bound: `sdk-key`, `:context`, `:bootstrap`, `:options`, `:client`.

**Mode A** (an `sdk-key`) means the provider builds the client and closes it when it unmounts. **Mode B** (a `client`) means you own its lifetime and the provider never closes it. Passing neither throws at setup with a message naming both fixes, rather than rendering a tree where every flag is silently the default.

### `Flag<T>`, the return type of every read

```ts
interface Flag<T = unknown> {
  /** The variation value, typed against the default you passed. */
  readonly value: T;
  /** Variation key, null when the default was served or the flag is unknown. */
  readonly variationKey: string | null;
  /** Why this value was produced. */
  readonly source: EvaluationSource;
  /** Rule that matched, null when none did. */
  readonly ruleId: string | null;
  readonly ruleType: RuleType | null;
  /** Structured reasons for this decision. Never null; may be empty. */
  readonly reasons: string[];
  /** ms-epoch when this was evaluated. */
  readonly evaluatedAt: number;
  /** Microseconds spent in the evaluator. */
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
| `not_ready`        | No datafile yet. Gate on `useFlagReady()`.                    | false           | false      |

"value-dependent" means `isEnabled()` is `Boolean(flag.value)`.

### `UseAvsbStatusResult`

```ts
interface UseAvsbStatusResult {
  status: ComputedRef<'loading' | 'ready' | 'error'>;
  error: ComputedRef<Error | undefined>;
  degraded: ComputedRef<boolean>;
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
teaches every composable in this package which keys exist. Its important parts:

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
import { useBoolFlag, useJsonFlag } from '@avsbhq/vue';
import type { FlagValues } from './generated/flags';

const checkout = useBoolFlag('checkout_v2', false);

// A JSON flag types its payload from the generated table:
const theme = useJsonFlag<FlagValues['theme']>('theme', { primary: '#111' });

// Once the generated file exists, this line stops compiling:
// 'chekcout_v2' is not a flag key.
const typo = useBoolFlag('chekcout_v2', false);
```

One real consequence for reactive keys: a `Ref<string>` no longer satisfies
`FlagKeyInput` once your keys are generated, because that ref could hold any
string. Declare it as `Ref<AvsbFlagKey>` (or `ComputedRef<AvsbFlagKey>`) and it
fits again.

Nothing changes for a project that never runs `codegen`: with no generated file
the table is empty, so `FlagKeyInput` accepts any string exactly as it does
today, and every call you have already written compiles unchanged. For a key
computed at runtime, widen deliberately with `key as AvsbFlagKey` (that type is
exported from `@avsbhq/core`).

---

## 5. Why `.value.value`

`useFlag` returns a `ComputedRef<Flag<T>>`. Vue refs are unwrapped with `.value`, and the flag's own field is also called `value`, so in `<script setup>` you write:

```ts
const checkout = useFlag('new_checkout_flow', false);

checkout.value.value; // boolean  (ref unwrap, then Flag.value)
checkout.value.isEnabled(); // boolean
checkout.value.variationKey; // string | null
```

In a template Vue unwraps the ref for you, so it is one `.value`:

```vue
<template>
  <NewCheckout v-if="checkout.value" />
</template>
```

This is a real papercut and we are not going to hide it behind a rename: `Flag.value` is the same field in seven SDKs, and renaming it here would make the Vue docs disagree with every other page and every code sample.

Two ways to make it read better:

```ts
import { computed } from 'vue';

// 1. Ask for the value instead of the Flag
const showNewCheckout = useFlagValue('new_checkout_flow', false);
showNewCheckout.value; // boolean, one .value everywhere

// 2. Destructure with toRefs-style naming at the top of setup
const checkoutFlag = useFlag('new_checkout_flow', false);
const isNewCheckout = computed(() => checkoutFlag.value.isEnabled());
```

---

## 6. Identity

```vue
<AvsbProvider :sdk-key="sdkKey" :context="{ kind: 'user', key: userId, plan: 'pro' }">
```

Anonymous visitors get a persisted id (localStorage, with a cookie fallback), so a returning visitor buckets into the same variation instead of being re-randomised on every load. If the A vs B web snippet is on the same page, the SDK adopts its visitor id so flag exposures and web experiment exposures join to one visitor.

```ts
import { useAvsbClient, useIdentify, useAlias, useReset } from '@avsbhq/vue';

const client = useAvsbClient();
const identify = useIdentify();
const alias = useAlias();
const reset = useReset();

function onSignIn(user: { id: string; email: string; plan: string }): void {
  const context = client.getContext();
  const anonymousKey: string = 'key' in context ? String(context['key']) : '';

  // Same person, two sessions: this is what lets results stitch them.
  alias({ kind: 'user', key: anonymousKey }, { kind: 'user', key: user.id });

  // From here on, flags evaluate for the signed-in user.
  identify({ kind: 'user', key: user.id, email: user.email, plan: user.plan });
}

function onSignOut(): void {
  reset(); // new anonymous identity, runtime overrides cleared
}
```

`alias` is synchronous: it queues one event and returns. There is nothing to await, and it does not rewrite assignments already made. To carry bucketing across a login, evaluate with the same context key on both sides.

### Multi-context

```ts
identify({
  kind: 'multi',
  user: { kind: 'user', key: 'u_123', plan: 'pro' },
  organization: { kind: 'organization', key: 'org_456', tier: 'enterprise' },
});
```

A rule can bucket on `user.key` while matching an audience condition on `organization.tier`.

---

## 7. Reading flags

```ts
import { useFlag, useBoolFlag, useJsonFlag } from '@avsbhq/vue';
import type { Flag } from '@avsbhq/vue';

const darkMode = useBoolFlag('dark_mode', false);

interface ApiConfig {
  timeout: number;
  retries: number;
}
const config = useJsonFlag<ApiConfig>('api_config', { timeout: 5000, retries: 3 });
const timeout: number = config.value.value.timeout;
```

The typed reads check the value against the type the platform declared for that flag. **On a mismatch nothing throws**: the SDK logs one warning naming the flag and the getter, then returns your `defaultValue` with `source: 'not_found'`. `useJsonFlag<T>` does not validate the shape of `T` at runtime, only that the flag is declared as JSON; validate the payload yourself if it crosses a trust boundary.

A default value is always required, and it is what you get before the SDK is ready or when the key is unknown.

### Reactive keys

```ts
import { ref } from 'vue';

const selected = ref('feature_a');
const flag = useFlag(selected, false); // re-subscribes when `selected` changes
```

### Every flag at once

```ts
const flags = useAllFlags(); // ComputedRef<Record<string, Flag>>
```

Re-computes on any flag change, so prefer `useFlag` in normal components. Exposures are suppressed and the SDK returns the same object between changes, so this is cheap to read on every render.

---

## 8. Exposures: what lands in your results

Reads during render never record an exposure. That is deliberate: an exposure means "this visitor saw this decision", and Vue can re-render a component any number of times for reasons that have nothing to do with the visitor.

```ts
import { useExposure } from '@avsbhq/vue';

// In the component that actually shows the variation:
useExposure('new_checkout_flow');
```

`useExposure` fires on mount, once, or as soon as the SDK becomes ready if it is not yet. It is also the piece that makes server-rendered variants visible in results: if a value arrived as a prop from the server, call `useExposure` where it is rendered.

Only decisions that belong in an experiment (A/B rules, holdouts, bandits) produce an exposure event; a plain rollout has nothing to record.

For side effects that are not rendering:

```ts
useFlagSubscription('new_checkout_flow', (flag) => {
  analytics.track('checkout_variant_assigned', { variationKey: flag.variationKey });
});
```

---

## 9. Readiness and failure

```vue
<script setup lang="ts">
import { useAvsbStatus } from '@avsbhq/vue';

const { status, error, degraded } = useAvsbStatus();
</script>

<template>
  <SkeletonApp v-if="status === 'loading'" />
  <template v-else>
    <StaleDataNotice v-if="degraded" :message="error?.message" />
    <MyApp />
  </template>
</template>
```

- `'loading'`: no datafile yet and nothing cached.
- `'ready'`: flags answer. A **degraded** client is ready: a refresh failed while a cached datafile is being served, so values work and may be stale. `error` says why.
- `'error'`: nothing could be loaded. Every flag returns the default you passed, and `error.message` names the HTTP status, the URL tried, and the fix.

The SDK's default logger writes to the console at `warn` level in development and is silent in production. Override it per client:

```ts
const options = { logLevel: 'silent' } as const;
```

```vue
<AvsbProvider :sdk-key="sdkKey" :options="{ logLevel: 'debug' }">
```

---

## 10. Server rendering

Fetch the datafile on the server and hand it to the provider, so the first render has real values instead of defaults:

```ts
// Server
import { fetchDatafile } from '@avsbhq/browser/server';
import type { FlagDatafile } from '@avsbhq/vue';

const sdkKey: string = process.env['AVSB_SDK_KEY'] ?? '';

const datafile: FlagDatafile | null = await fetchDatafile(sdkKey, { timeout: 2000 });
```

```vue
<!-- Client -->
<AvsbProvider :sdk-key="sdkKey" :bootstrap="datafileFromServer" :context="userContext">
  <App />
</AvsbProvider>
```

With a bootstrap the client is ready on the first pass: `useFlagReady()` is already `true`, no loading state renders, and the values match what the server rendered. Serialise the datafile into the page the way your framework escapes JSON.

For Nuxt apps, use the @avsbhq/nuxt module, which wires this plugin, SSR bootstrap, and auto-imports for you. Outside Nuxt, the pattern above is the whole SSR story for Vue, and it is honest: without a bootstrap the first render shows your defaults.

---

## 11. Pinia (optional)

```ts
import { useAvsbStore } from '@avsbhq/vue/pinia';

const avsb = useAvsbStore();

avsb.status; // 'loading' | 'ready' | 'error'
avsb.degraded; // boolean
avsb.flags; // Record<string, Flag>, refreshed on any flag change
avsb.identify({ kind: 'user', key: 'u_1' });
avsb.track('checkout_started', { value: 99 });
avsb.reset();
```

The store reflects the provider; it never creates a client. The first component that calls `useAvsbStore()` binds it, so that call has to happen somewhere under `<AvsbProvider>` (or in an app that installed `AvsbPlugin`).

This lives on its own entry point on purpose. Importing it from the main barrel used to pull `pinia` into every Vue app whether or not it used Pinia, which broke module resolution for everyone else.

---

## 12. Plugin form

```ts
import { createApp } from 'vue';
import { AvsbPlugin } from '@avsbhq/vue';
import App from './App.vue';

declare const userId: string;

const app = createApp(App);

app.use(AvsbPlugin, {
  sdkKey: import.meta.env['VITE_AVSB_SDK_KEY'] as string,
  context: { kind: 'user', key: userId },
});

app.mount('#app');
```

Same semantics as the component, provided at app level. In Mode A the plugin closes the client when the app unmounts, which flushes whatever events are queued.

### One provider, please

Nesting a second `<AvsbProvider>` inside another shadows the outer one for everything below it: two clients, two visitor ids, two event queues, and identify calls that only reach one of them. The provider logs a warning in development when it detects this. Mount one provider at the root unless you deliberately want an isolated subtree.

---

## 13. Graceful shutdown

Mode A closes the client for you on unmount, which flushes queued events. In Mode B you own it:

```ts
import { onUnmounted } from 'vue';

onUnmounted(async () => {
  await client.close(); // flushes internally
});
```

---

## 14. Testing

```ts
import { mount } from '@vue/test-utils';
import { AvsbTestProvider } from '@avsbhq/vue/testing';
import CheckoutButton from './CheckoutButton.vue';

const wrapper = mount(AvsbTestProvider, {
  props: { flags: { 'checkout_v2': true } },
  slots: { default: CheckoutButton },
});
```

`AvsbTestProvider` is the real `<AvsbProvider>` in Mode B around a real `AvsbClient` whose datafile is built from your flags map, with the network, the cache, and logging switched off. Your components use the same composables, the same evaluator, and the same exposure rules they use in production.

Each entry in `flags` becomes a flag that is fully rolled out, so `isEnabled()` is true for truthy values and reads record exposures exactly as an A/B rule would.

Drive the client directly when that is simpler:

```ts
import { createTestClient, createTestDatafile } from '@avsbhq/vue/testing';

const client = createTestClient({
  flags: { 'checkout_v2': true },
  context: { kind: 'user', key: 'u_1' },
});

expect(client.getBoolFlag('checkout_v2', false).isEnabled()).toBe(true);

// Publish a new datafile and watch subscribers wake up.
client.applyDatafileBootstrap(
  createTestDatafile({ 'checkout_v2': false }, { publishedAt: '2024-06-01T00:00:00.000Z' }),
);
```

```ts
import type { AvsbClient } from '@avsbhq/browser';
import type { FlagDatafileEntry } from '@avsbhq/vue';

/** Flag key to the value it serves. */
type TestFlags = Record<string, boolean | string | number | object | null>;

interface TestClientOptions {
  flags?: TestFlags;
  context?: EvalContext;
  /** A full datafile, for when a map of values is not expressive enough. */
  datafile?: FlagDatafile;
}

function createTestClient(options?: TestClientOptions): AvsbClient;
function createTestDatafile(
  flags?: TestFlags,
  options?: {
    sdkKey?: string;
    environmentKey?: string;
    publishedAt?: string;
    entries?: FlagDatafileEntry[];
  },
): FlagDatafile;
```

Call `client.close()` at the end of a test that tracked events, so the flush timer does not outlive it.

---

## 15. Migration from LaunchDarkly

| LaunchDarkly                           | `@avsbhq/vue`                                      |
| -------------------------------------- | -------------------------------------------------- |
| `LDPlugin` / `asyncWithLDProvider`     | `<AvsbProvider sdk-key>` or `app.use(AvsbPlugin)`  |
| `ldClient.waitForInitialization()`     | `useFlagReady()` or `useAvsbStatus()`              |
| `useFlags()`                           | `useAllFlags()`                                    |
| `ldClient.variation('key', false)`     | `useBoolFlag('key', false).value.value`            |
| `ldClient.variationDetail('key', d)`   | `useFlag('key', d)`                                |
| `ldClient.identify(context)`           | `useIdentify()(context)`                           |
| `ldClient.track('event', data, value)` | `useTrack()('event', { value, properties: data })` |
| `ldClient.on('change:key', cb)`        | `useFlagSubscription('key', cb)`                   |

Differences worth knowing:

- Every read returns a `Flag<T>` object, not a raw value, so you get the decision metadata without a second call.
- Every read requires an explicit default. There is no untyped variation call.
- Multi-context is first class: one `EvalContext` with kinds, no wrapper type.
- Reads during render record no exposure. Call `useExposure` where the visitor actually sees the decision.

---

## 16. Set this up with your AI assistant

Paste this into Claude Code, Cursor, or any coding assistant:

```text
Set up A vs B feature flags in this Vue project.

1. Run: npx @avsbhq/cli init
   Use my saved CLI login: do not ask me for a token and do not put one in any file.
   It detects Vue, writes the SDK key into the environment file this project's
   bundler reads (VITE_AVSB_SDK_KEY for Vite), and writes an example component.
2. Install @avsbhq/vue with this project's package manager.
3. Mount <AvsbProvider> once at the root with that key and a context of
   { kind: 'user', key: <your user id> }, then read the flag the example names.
4. Every getter returns a ref to a Flag object, so keep the ref and read
   flag.value.value or call flag.value.isEnabled(), and always pass a fallback.
   Reading a flag records nothing: call useExposure(key) where the variation is
   shown.
5. Then run: npx @avsbhq/cli codegen

Done looks like: the app starts, the flag reads without throwing, and avsb init
prints the line confirming it saw the first check-in.
```

`avsb init` ends by waiting for your app's first check-in and printing what it
saw, so the terminal tells you it works rather than the dashboard.
