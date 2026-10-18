# @avsbhq/flags-adapter

[A vs B](https://app.avsb.cloud) adapter for the [Flags SDK](https://flags-sdk.dev).

Declare a flag once with `flag()`, point it at this adapter, and every read is a real A vs B evaluation: targeting rules, A/B splits, holdouts, bandits, and a server-side exposure so the decision shows up in your results.

---

## 1. Install

```bash
npm install @avsbhq/flags-adapter flags
```

`flags` is a peer dependency. This package never imports it: it matches the adapter shape structurally, so a `flags` upgrade cannot break it at build time.

---

## 2. Quickstart

```ts
// flags.ts
// docs-example: not typechecked here, because `identify` takes its types from the
// Flags SDK's flag() declaration, and this repo does not install flags.
import { flag } from 'flags/next';
import { avsbAdapter } from '@avsbhq/flags-adapter';
import type { EvalContext } from '@avsbhq/flags-adapter';

export const newCheckout = flag<boolean, EvalContext>({
  key: 'new-checkout-flow',
  adapter: avsbAdapter.booleanValue(),
  defaultValue: false,
  identify: ({ cookies }) => ({
    kind: 'user',
    key: cookies.get('uid')?.value ?? 'anonymous',
  }),
});
```

```tsx
// app/page.tsx
import { newCheckout } from '../flags';

export default async function Page() {
  const showNewCheckout = await newCheckout();
  return showNewCheckout ? <NewCheckout /> : <Checkout />;
}
```

`AVSB_SDK_KEY` in the environment is the only configuration `avsbAdapter` needs.

---

## 3. SDK keys

Get the SDK key for the environment you want from your project: **app.avsb.cloud**, then **Settings**, then **Environments**. The format is `sdk_<environment>_<id>`, for example `sdk_production_ttqm0eaj4vth1krcb2xn`.

There is one SDK key per environment, and "SDK key" is its only name. There is no separate client key and server key to choose between.

Your SDK key is a public identifier, not a secret: it is safe to ship in browser and mobile bundles, it can only fetch that environment's flag configuration and send events, and it can never read or change anything in your dashboard.

```bash
AVSB_SDK_KEY=sdk_production_ttqm0eaj4vth1krcb2xn
```

With no key, the adapter logs one error naming the fix and every flag returns the `defaultValue` from its declaration. It never throws, so a missing key cannot take a page down.

---

## 4. The whole type surface

Every name below is exported by this package, with one exception: `Logger` is the shared logger interface from `@avsbhq/core`.

```ts
import type { Adapter, AvsbClientFactory, AvsbEvaluator, EvalContext } from '@avsbhq/flags-adapter';
import type { Logger } from '@avsbhq/core';
```

```ts
function createAvsbAdapter(options?: CreateAvsbAdapterOptions): AvsbAdapter;

/** Reads AVSB_SDK_KEY from the environment. Builds its client on first use. */
const avsbAdapter: AvsbAdapter;

interface AvsbAdapter {
  booleanValue(): Adapter<boolean, EvalContext>;
  stringValue(): Adapter<string, EvalContext>;
  numberValue(): Adapter<number, EvalContext>;
  /** The fallback is required: there is no empty value for an arbitrary shape. */
  jsonValue<T>(fallback: T): Adapter<T, EvalContext>;
  /** Which arm of the experiment this request landed in. Null when nothing was decided. */
  variationKey(): Adapter<string | null, EvalContext>;
  /** The underlying client once ready, or null when it could not be created. */
  avsbClient(): Promise<AvsbEvaluator | null>;
  /** Flush queued events and stop polling. */
  close(): Promise<void>;
}

interface CreateAvsbAdapterOptions {
  /** Defaults to process.env.AVSB_SDK_KEY. */
  sdkKey?: string;
  /** CDN base for datafile fetches. Default 'https://cdn.avsb.cloud'. */
  cdnHost?: string;
  /** A client you already run, or a factory for one. */
  client?: AvsbEvaluator | AvsbClientFactory;
  /** Record an exposure per decision. Default 'auto'. */
  exposure?: 'auto' | 'off';
  /** Cookie carrying the anonymous visitor id. Default 'avsb_anon_id'. */
  anonCookieName?: string;
  /** Where the Vercel Toolbar links this flag. */
  origin?: string | ((flagKey: string) => string | undefined);
  /** Defaults to the console at warn level. */
  logger?: Logger;
}
```

The entities type is `EvalContext`, the same context object every A vs B SDK takes:

```ts
type EvalContext = SingleContext | MultiContext;

interface SingleContext {
  kind: string;
  key: string;
  [attribute: string]: unknown;
}

interface MultiContext {
  kind: 'multi';
  [contextKind: string]: SingleContext | 'multi';
}
```

Multi-context works here exactly as it does elsewhere, so a rule can bucket on `user.key` while matching an audience condition on `organization.tier`:

```ts
import type { CookiesLike } from '@avsbhq/flags-adapter';

// Hand this to a flag declaration as its `identify`.
const identifyUserAndOrg = ({ cookies }: { cookies: CookiesLike }): EvalContext => ({
  kind: 'multi',
  user: { kind: 'user', key: cookies.get('uid')?.value ?? 'anonymous' },
  organization: { kind: 'organization', key: 'org_456', tier: 'enterprise' },
});
```

---

## 5. Identity

`identify` is where a decision gets its visitor, and it is worth writing: without one, results are attributed to whoever the fallback finds.

The fallback, in order:

1. The `avsb_anon_id` cookie. Set it server-side with the `withAvsb` middleware from `@avsbhq/next`, which maintains it on every request. Do not count on the browser SDK for it: the browser persists the same id in `localStorage` first and only writes a cookie when `localStorage` is unavailable, so on most sites this cookie exists only because your middleware wrote it.
2. The web snippet's `_avsb_visitor` cookie, decoded the way the snippet writes it (percent-encoded JSON, id in `v`). When Web Experiments is installed on the same domain, this is what makes the flag decision and the experiment exposure land on one visitor instead of two. A cookie of that name that does not parse is ignored.
3. Nothing. The flag returns its `defaultValue`, no exposure is recorded, and one warning per flag key says what to add.

That last case is deliberate. Inventing an id per request would split one visitor across every page view and quietly corrupt the experiment.

`readSnippetVisitorId(rawCookieValue: string | null): string | null` is exported if you want that decoding inside your own `identify`.

---

## 6. Exposures

Every `decide` records an exposure by default, because a Flags SDK read happens at request time for one visitor: that is a decision, and results need it.

Turn it off for flags you read early (middleware, a layout) and show later:

```ts
import { createAvsbAdapter } from '@avsbhq/flags-adapter';

export const avsbAdapter = createAvsbAdapter({ exposure: 'off' });
```

Then record the exposure where the visitor actually sees the variation, either with `useExposure` from the framework SDK on the client, or `manualExposure` on a bound server client.

---

## 7. Bring your own client

An app that already runs `AvsbServer` should hand it over, so the process holds one datafile, one polling loop and one event queue:

```ts
import { AvsbServer } from '@avsbhq/node';
import { createAvsbAdapter } from '@avsbhq/flags-adapter';

export const avsb = new AvsbServer({ sdkKey: process.env.AVSB_SDK_KEY ?? '' });
export const avsbAdapter = createAvsbAdapter({ client: avsb });
```

`AvsbServer` satisfies `AvsbEvaluator`, so nothing needs casting. Pass a factory instead of an instance to defer construction:

```ts
export const lazyAvsbAdapter = createAvsbAdapter({
  client: () => new AvsbServer({ sdkKey: process.env.AVSB_SDK_KEY ?? '' }),
});
```

---

## 8. Failure behaviour

Nothing in this adapter throws. Each of these ends with the flag's declared default value and one log line:

| What happened                    | What you see                                                 |
| -------------------------------- | ------------------------------------------------------------ |
| No SDK key                       | One error naming `AVSB_SDK_KEY` and where the key lives.     |
| Datafile never loaded            | One error with the HTTP status and the URL tried.            |
| Nobody could be identified       | One warning per flag key naming `identify()` and the cookie. |
| Flag key not in this environment | The SDK logs the unknown key; the default is served.         |

---

## 9. What this adapter does not do

- It does not evaluate in the browser. The Flags SDK runs flags on the server; for client-side reading use `@avsbhq/react`, `@avsbhq/vue`, `@avsbhq/svelte`, `@avsbhq/solid` or `@avsbhq/angular`.
- It does not expose `Flag<T>` metadata (reasons, rule ids) through `decide`, because a flag value has to survive serialisation. Reach for `avsbClient()` when you need the whole decision.
- It is not an OpenFeature provider. That is a separate integration, documented in the A vs B docs.
