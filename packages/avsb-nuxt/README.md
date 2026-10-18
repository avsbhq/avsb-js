# @avsbhq/nuxt

Nuxt module for the [A vs B](https://app.avsb.cloud) platform.

One line in `nuxt.config`, and every component can read feature flags with auto-imported composables. The datafile is fetched while the page renders on the server and travels to the browser in the payload, so the first paint shows real values instead of your defaults.

Built on [`@avsbhq/vue`](https://www.npmjs.com/package/@avsbhq/vue), which is built on [`@avsbhq/browser`](https://www.npmjs.com/package/@avsbhq/browser). Anything the Vue SDK can do, this module can do: it installs the same plugin for you and adds the Nuxt half (config, auto-imports, server rendering).

---

## 1. Install

```bash
npm install @avsbhq/nuxt
```

Nuxt 3.7 or later is required as a peer dependency. Nuxt 4 is supported.

---

## 2. Quickstart

```ts
// nuxt.config.ts
// docs-example: not typechecked here, because `defineNuxtConfig` and the `avsb`
// config key both come from the types Nuxt generates into a project's .nuxt
// directory when it registers this module, and no npm package supplies them.
export default defineNuxtConfig({
  modules: ['@avsbhq/nuxt'],
  avsb: {
    sdkKey: process.env.AVSB_SDK_KEY,
  },
});
```

```vue
<!-- components/CheckoutButton.vue -->
<script setup lang="ts">
// No import line: the module auto-imports the composables.
const newCheckout = useBoolFlag('new_checkout_flow', false);
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

That is the whole setup. There is no provider to mount and no plugin to write.

---

## 3. SDK keys

Get the SDK key for the environment you want from your project: **app.avsb.cloud**, then **Environments** in the project sidebar. The format is `sdk_<environment>_<id>`, for example `sdk_production_ttqm0eaj4vth1krcb2xn`.

There is one SDK key per environment, and "SDK key" is its only name. There is no separate client key and server key to choose between.

Your SDK key is a public identifier, not a secret: it is safe to ship in browser and mobile bundles, it can only fetch that environment's flag configuration and send events, and it can never read or change anything in your dashboard.

Because the key lives in `runtimeConfig.public`, Nuxt lets you point a built app at another environment without rebuilding it:

```bash
NUXT_PUBLIC_AVSB_SDK_KEY=sdk_production_ttqm0eaj4vth1krcb2xn node .output/server/index.mjs
```

The module reads `avsb.sdkKey` first, then `NUXT_PUBLIC_AVSB_SDK_KEY`, then `AVSB_SDK_KEY`. With none of them set it warns at build time, and at runtime it creates no client and says so once, naming the fix.

The client also checks the shape of the key when it is constructed. A key that does not look like an SDK key (a pasted dashboard URL, a truncated copy, a personal access token or a service token) logs one actionable error naming what it got and where the real key lives.

---

## 4. What the module does

1. Publishes your settings to `runtimeConfig.public.avsb`.
2. Auto-imports the `@avsbhq/vue` composables (section 6).
3. Registers one plugin that runs on both sides:
   - **Server**: fetches the datafile (once per process per TTL, and once for a burst of concurrent requests), puts it in the payload, and installs the Vue plugin with a client that has no timers, no cache and no network. Flags are answered from that datafile while the page renders.
   - **Browser**: reads the same datafile out of the payload and installs the Vue plugin with a live client that starts ready. Nothing is fetched before the first paint, and no flag flickers from a default to its real value.

---

## 5. Module options

```ts
import type { AvsbClientOptions } from '@avsbhq/browser';

interface AvsbModuleOptions {
  /** SDK key. Falls back to NUXT_PUBLIC_AVSB_SDK_KEY, then AVSB_SDK_KEY. */
  sdkKey?: string;
  /** Fetch the datafile during server rendering and send it in the payload. Default true. */
  bootstrap?: boolean;
  /** Auto-import the composables. Default true. */
  autoImports?: boolean;
  /** CDN base for datafile fetches. Default 'https://cdn.avsb.cloud'. */
  cdnHost?: string;
  /** Milliseconds the server-side datafile fetch may take. Default 3000. */
  bootstrapTimeout?: number;
  /** Milliseconds a server-fetched datafile is reused across requests. Default 60000. */
  bootstrapMaxAge?: number;
  /** Everything else AvsbClient accepts that survives JSON. */
  client?: AvsbClientRuntimeOptions;
}

/** Derived from AvsbClientOptions, so it cannot drift from the SDK. */
type AvsbClientRuntimeOptions = Pick<
  AvsbClientOptions,
  | 'pollingInterval'
  | 'autoRefresh'
  | 'cdnHost'
  | 'initTimeout'
  | 'cache'
  | 'cacheMaxAgeMs'
  | 'adoptSnippetVisitorId'
  | 'pauseWhenHidden'
  | 'refetchOnFocus'
  | 'maxPendingEvents'
  | 'streaming'
  | 'streamingEndpoint'
  | 'logLevel'
>;
```

`logger` and `onError` are absent from `client` because `runtimeConfig` cannot carry functions. If you need them, build your own client and mount `<AvsbProvider :client="client">` from `@avsbhq/vue` instead of using this module.

```ts
// nuxt.config.ts
// docs-example: not typechecked here, because `defineNuxtConfig` and the `avsb`
// config key both come from the types Nuxt generates into a project's .nuxt
// directory when it registers this module, and no npm package supplies them.
export default defineNuxtConfig({
  modules: ['@avsbhq/nuxt'],
  avsb: {
    sdkKey: process.env.AVSB_SDK_KEY,
    bootstrapMaxAge: 30_000,
    client: { pollingInterval: 30_000, logLevel: 'debug' },
  },
});
```

Settings under `avsb.client` never override the SDK key, and never turn polling, caching or streaming back on during a server render.

---

## 6. What gets auto-imported

```
useFlag        useFlagValue    useBoolFlag     useStringFlag
useNumberFlag  useJsonFlag     useAllFlags     useFlagReady
useAvsbStatus  useAvsbClient   useIdentify     useAlias
useReset       useTrack        useExposure     useFlagSubscription
```

Every one is the composable from `@avsbhq/vue`, with the same signature and the same behaviour. Their reference is the [`@avsbhq/vue` README](https://www.npmjs.com/package/@avsbhq/vue): what a `Flag<T>` carries, why a read in `<script setup>` needs `.value.value`, when an exposure is recorded, and what `useAvsbStatus()` reports.

Set `autoImports: false` and import them yourself:

```ts
import { useBoolFlag } from '@avsbhq/vue';
```

`AvsbProvider` and `AvsbPlugin` are deliberately not auto-imported. The module already installs one, and a second provider inside it would run two clients with two visitor ids.

---

## 7. Server rendering

### The default: the module fetches the datafile

Nothing to write. The plugin fetches the datafile on the server, caches it for `bootstrapMaxAge` across requests, and deduplicates concurrent requests so a burst of traffic triggers one fetch. A failed fetch is never cached: the page renders your default values, one warning says why, and the next request tries again.

### If you already run a server client

Apps that evaluate flags in Nitro routes with `@avsbhq/node` already hold a datafile. Hand that one over instead of paying for a second fetch:

```ts
// plugins/avsb-bootstrap.server.ts
import { defineNuxtPlugin, useState } from 'nuxt/app';
import { AVSB_BOOTSTRAP_STATE_KEY, getAvsbBootstrap } from '@avsbhq/nuxt/server';
import type { FlagDatafile } from '@avsbhq/nuxt/server';
import { avsbServer } from '../server/avsb';

export default defineNuxtPlugin(() => {
  const bootstrap = useState<FlagDatafile | null>(AVSB_BOOTSTRAP_STATE_KEY, () => null);
  bootstrap.value = getAvsbBootstrap(avsbServer);
});
```

The module's own plugin runs with `enforce: 'post'`, so a plugin like that one has already run and the module leaves the value alone.

`getAvsbBootstrap` is the same helper, with the same name and meaning, that `@avsbhq/svelte/sveltekit` and `@avsbhq/solid/solid-start` ship: it hands back the DATAFILE, which is what the browser client's `bootstrap` option takes. It is JSON-safe by construction, because it is the document the CDN serves.

### `@avsbhq/nuxt/server`

```ts
import type { DatafileFetcher } from '@avsbhq/nuxt/server';

const AVSB_BOOTSTRAP_STATE_KEY: 'avsb:bootstrap';
const AVSB_CONTEXT_STATE_KEY: 'avsb:context';

interface AvsbServerClient {
  getDatafile(): FlagDatafile | null;
}

function getAvsbBootstrap(serverClient: AvsbServerClient): FlagDatafile | null;

interface LoadDatafileOptions {
  cdnHost?: string;
  /** Milliseconds before the fetch is abandoned. Default 3000. */
  timeoutMs?: number;
  /** Milliseconds a fetched datafile is reused across requests. Default 60000. */
  maxAgeMs?: number;
  onError?: (error: Error) => void;
}

interface DatafileLoader {
  load(sdkKey: string, options?: LoadDatafileOptions): Promise<FlagDatafile | null>;
  clear(): void;
}

function createDatafileLoader(options?: {
  fetchDatafile?: DatafileFetcher;
  now?: () => number;
}): DatafileLoader;

/** The loader the module's own plugin uses. One per server process. */
const avsbDatafileLoader: DatafileLoader;
```

`AvsbServer` from `@avsbhq/node` satisfies `AvsbServerClient`, so nothing needs casting.

### Turning it off

```ts
avsb: {
  bootstrap: false;
}
```

The datafile then stays out of the HTML and the browser fetches it itself. The trade is honest: smaller payload, and the first paint shows the default value you passed until the datafile lands.

---

## 8. Identity

Without a context the visitor gets a persisted anonymous id (localStorage, with a cookie fallback), so a returning visitor buckets into the same variation instead of being re-randomised on every load.

For a signed-in user, set the context for the request on the server and both sides evaluate the same person:

```ts
// plugins/avsb-identity.server.ts
import { defineNuxtPlugin, useCookie, useState } from 'nuxt/app';
import { AVSB_CONTEXT_STATE_KEY } from '@avsbhq/nuxt/server';
import type { EvalContext } from '@avsbhq/core';

export default defineNuxtPlugin(() => {
  const userId = useCookie<string | null>('uid').value;
  const context = useState<EvalContext | null>(AVSB_CONTEXT_STATE_KEY, () => null);

  if (userId) context.value = { kind: 'user', key: userId, plan: 'pro' };
});
```

After a login in the browser, switch identity through the composable:

```ts
// Auto-imported in a Nuxt app. This is the import line you write when
// `autoImports` is off.
import { useAlias, useIdentify, useReset } from '@avsbhq/vue';

declare const anonymousKey: string;
declare const user: { id: string; email: string; plan: string };

const identify = useIdentify();
const alias = useAlias();
const reset = useReset();

// Same person, two sessions: this is what lets results stitch them.
alias({ kind: 'user', key: anonymousKey }, { kind: 'user', key: user.id });
identify({ kind: 'user', key: user.id, email: user.email, plan: user.plan });

// On sign-out: a new anonymous identity, runtime overrides cleared.
reset();
```

Multi-context works the same way it does in every A vs B SDK:

```ts
const workspaceContext: EvalContext = {
  kind: 'multi',
  user: { kind: 'user', key: 'u_123', plan: 'pro' },
  organization: { kind: 'organization', key: 'org_456', tier: 'enterprise' },
};

// On the server, in the plugin above: context.value = workspaceContext
identify(workspaceContext);
```

---

## 9. Readiness and failure

```vue
<script setup lang="ts">
const { status, error, degraded } = useAvsbStatus();
</script>

<template>
  <SkeletonApp v-if="status === 'loading'" />
  <template v-else>
    <StaleDataNotice v-if="degraded" :message="error?.message" />
    <NuxtPage />
  </template>
</template>
```

With the default bootstrap the status is already `'ready'` on the first render, so this is a safety net rather than a loading screen you will see.

- `'loading'`: no datafile yet and nothing cached.
- `'ready'`: flags answer. A **degraded** client is ready: a refresh failed while a cached datafile is being served, so values work and may be stale. `error` says why.
- `'error'`: nothing could be loaded. Every flag returns the default you passed, and `error.message` names the HTTP status, the URL tried, and the fix.

The SDK's default logger writes to the console at `warn` level in development and is silent in production. Change it with `avsb: { client: { logLevel: 'debug' } }`.

---

## 10. Testing

Component tests do not go through Nuxt's plugin, so use the Vue package's test provider directly:

```ts
import { mount } from '@vue/test-utils';
import { AvsbTestProvider } from '@avsbhq/vue/testing';
import CheckoutButton from './CheckoutButton.vue';

const wrapper = mount(AvsbTestProvider, {
  props: { flags: { 'checkout_v2': true } },
  slots: { default: CheckoutButton },
});
```

That is the real provider around a real client whose datafile is built from your flags map, with the network, the cache and logging switched off. Your components use the same composables and the same evaluator they use in production.

---

## 11. What this module does not do

- It does not evaluate flags inside Nitro server routes. For server-side evaluation, use `@avsbhq/node` in your Nitro code and (optionally) hand its datafile to the page with `getAvsbBootstrap`.
- It does not register components. The composables are the API.
- It does not add its own devtools panel.

---

## 12. Set this up with your AI assistant

Paste this into Claude Code, Cursor, or any coding assistant:

```text
Set up A vs B feature flags in this Nuxt project.

1. Run: npx @avsbhq/cli init
   Use my saved CLI login: do not ask me for a token and do not put one in any file.
   It detects Nuxt, writes the SDK key into .env as NUXT_PUBLIC_AVSB_SDK_KEY, and
   writes an example component.
2. Install @avsbhq/nuxt with this project's package manager.
3. Add "@avsbhq/nuxt" to the modules array in nuxt.config.ts. There is no provider
   to mount: the module auto-imports the composables.
4. Read the flag the example names with useBoolFlag(key, false). Every getter
   returns a Flag object, so read .value or call .isEnabled(), and always pass a
   fallback. Reading a flag records nothing: call useExposure(key) where the
   variation is shown.
5. Then run: npx @avsbhq/cli codegen

Done looks like: the app starts, the flag reads without throwing, and avsb init
prints the line confirming it saw the first check-in.
```

`avsb init` ends by waiting for your app's first check-in and printing what it
saw, so the terminal tells you it works rather than the dashboard.
