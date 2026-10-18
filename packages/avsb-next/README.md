# @avsbhq/next

Next.js integration for the [A vs B](https://app.avsb.cloud) platform.

App Router and Pages Router, with server evaluation, a safe bootstrap into the page, and one component that wires the whole thing up. Built on `@avsbhq/react`, whose hooks are all re-exported here, so app code needs one import.

---

## 1. Install

```bash
npm install @avsbhq/next
```

Next.js 15 or later and React 18 or later, as peer dependencies.

That one install covers everything this package uses: `@avsbhq/core`, `@avsbhq/browser`, `@avsbhq/react` and `@avsbhq/utils` are real dependencies and arrive with it. `@avsbhq/node` is NOT one of them, so install it separately when you also want the server SDK.

---

## 2. Quickstart

One component, in your root layout:

```tsx
// app/layout.tsx
import { AvsbRoot } from '@avsbhq/next/server';
import type { ReactNode } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AvsbRoot>{children}</AvsbRoot>
      </body>
    </html>
  );
}
```

```
# .env
AVSB_SDK_KEY=sdk_production_...
```

Then read flags in any client component:

```tsx
// app/CheckoutButton.tsx
'use client';
import { useBoolFlag, useExposure, useTrack } from '@avsbhq/next';
import type { Flag } from '@avsbhq/next';

export function CheckoutButton() {
  const flag: Flag<boolean> = useBoolFlag('new_checkout_flow', false);
  const track = useTrack();
  useExposure('new_checkout_flow');

  return (
    <button onClick={() => track('checkout_clicked')}>
      {flag.isEnabled() ? 'New checkout' : 'Checkout'}
    </button>
  );
}
```

That is the whole setup. `<AvsbRoot>` resolves the visitor, fetches the datafile, evaluates every flag on the server, writes a safely escaped bootstrap into the page, and mounts the client provider with the datafile already in hand, so the HTML your users receive contains their variation and the browser makes no request before first paint.

Add the middleware to keep an anonymous visitor stable across visits:

```ts
// middleware.ts
import { withAvsb } from '@avsbhq/next/middleware';

export const middleware = withAvsb();

export const config = { matcher: ['/((?!_next|.*\\..*).*)'] };
```

Without it, a Server Component cannot write a cookie, so an anonymous visitor is re-randomised on every request and their results do not add up. The SDK says so, once, in your server logs.

On Next.js 16 the middleware file is called `proxy.ts` and its export `proxy`: `export const proxy = withAvsb();` in `proxy.ts` does the same job. A `middleware.ts` still works on 16, with a deprecation warning in the dev server.

---

## 3. SDK keys

One key per environment, format `sdk_<environment>_<id>`, from **Environments** in your A vs B project's sidebar.

`<AvsbRoot>` reads `AVSB_SDK_KEY`, then `NEXT_PUBLIC_AVSB_SDK_KEY`, or takes `sdkKey` directly. You do not need both variables: the key reaches the browser as a prop either way, which is safe. An SDK key is scoped to one environment and grants flag reads only. It cannot write to your project or read another environment.

---

## 4. The whole type surface

The signatures below name the package's own types, plus React's and Next's. They come from here:

```ts
import type {
  AvsbBootstrapBlob,
  EvalContext,
  Flag,
  FlagDatafile,
  SerializedFlag,
  SerializedFlagMap,
} from '@avsbhq/next/server';
import type { AvsbClientOptions } from '@avsbhq/browser';
import type { RequestBoundClient } from '@avsbhq/utils';
import type { NextRequest } from 'next/server';
import type { ReactElement, ReactNode } from 'react';
```

### `@avsbhq/next/server`

```ts
function AvsbRoot(props: AvsbRootProps): Promise<ReactElement>;

interface AvsbRootProps {
  sdkKey?: string; // defaults to AVSB_SDK_KEY, then NEXT_PUBLIC_AVSB_SDK_KEY
  context?: EvalContext; // defaults to the anonymous visitor cookie
  cdnHost?: string; // default 'https://cdn.avsb.cloud'
  revalidate?: number; // seconds, default 60
  cookie?: AnonCookieOptions;
  emitBootstrapScript?: boolean; // default true
  children: ReactNode;
}

function getDatafile(sdkKey: string, options?: GetDatafileOptions): Promise<FlagDatafile>;

interface GetDatafileOptions {
  cdnHost?: string;
  timeoutMs?: number; // default 5000
  revalidate?: number; // seconds, default 60
  signal?: AbortSignal;
}

/** The default `revalidate` window, in seconds. Mirrors the CDN cache header. */
const DEFAULT_REVALIDATE_SECONDS: number; // 60

function evaluateFlagServer<T>(
  datafile: FlagDatafile,
  ctx: EvalContext,
  flagKey: string,
  defaultValue: T,
): Flag<T>;

function evaluateServerFlags(datafile: FlagDatafile, context: EvalContext): SerializedFlagMap;

/** Strip one `Flag` down to the wire shape @avsbhq/react revives. */
function serializeFlag(flag: Flag<unknown>): SerializedFlag;

function AvsbHydrator(props: AvsbHydratorProps): Promise<ReactElement>;

interface AvsbHydratorProps {
  datafile?: FlagDatafile;
  sdkKey?: string;
  cdnHost?: string;
  context: EvalContext;
  includeDatafile?: boolean; // default true
}

function serializeBootstrapBlob(blob: AvsbBootstrapBlob): string;
const AVSB_BOOTSTRAP_ID: string;

// The anonymous visitor cookie, shared with the middleware.
const AVSB_ANON_COOKIE: string; // 'avsb_anon_id'
const AVSB_ANON_MAX_AGE_SECONDS: number; // one year
function createAnonId(): string;
function isAnonId(value: string | undefined | null): value is string;
function resolveAnonId(existing: string | undefined | null): { id: string; isNew: boolean };
function resolveAnonCookieOptions(options?: AnonCookieOptions): ResolvedAnonCookie;

interface AnonCookieOptions {
  name?: string;
  maxAgeSeconds?: number;
  path?: string;
  sameSite?: 'lax' | 'strict' | 'none';
  secure?: boolean;
  domain?: string;
}

/** The same attributes with every default filled in. */
interface ResolvedAnonCookie {
  name: string;
  maxAge: number;
  path: string;
  sameSite: 'lax' | 'strict' | 'none';
  secure: boolean;
  domain?: string;
  /** Never httpOnly: the browser SDK reads this id too. */
  httpOnly: false;
}
```

### `@avsbhq/next/middleware`

```ts
function withAvsb(
  middleware?: NextMiddleware,
  options?: WithAvsbOptions,
): (request: NextRequest) => Promise<Response>;

type NextMiddleware = (request: NextRequest) => MiddlewareResult | Promise<MiddlewareResult>;
type MiddlewareResult = Response | undefined | null | void;

interface WithAvsbOptions {
  server?: NextAppAvsbServer;
  contextFrom?: (request: NextRequest) => EvalContext | undefined;
  withDecisionLog?: boolean;
  cookie?: AnonCookieOptions | false;
}

/** Open the same request scope around a route handler. */
function nextAppHandler<TArgs extends unknown[], TResult>(
  server: NextAppAvsbServer,
  opts: NextAppMiddlewareOptions,
  handler: (req: Request, ...rest: TArgs) => Promise<TResult>,
): (req: Request, ...rest: TArgs) => Promise<TResult>;

/** The primitive both of the above are built on. Re-exported from @avsbhq/utils. */
function withNextRequest<T>(
  server: NextAppAvsbServer,
  opts: NextAppMiddlewareOptions,
  req: Request,
  handler: () => Promise<T>,
): Promise<T>;

interface NextAppAvsbServer {
  forUser(ctx: EvalContext): RequestBoundClient;
}

interface NextAppMiddlewareOptions {
  contextFrom(req: Request): EvalContext | undefined;
  withDecisionLog?: boolean;
}
```

### `@avsbhq/next/pages`

```ts
function getServerSideAvsb<P extends Record<string, unknown> = Record<string, never>>(
  options: GetServerSideAvsbOptions,
  handler?: (avsbCtx: AvsbGsspContext) => Promise<{ props: P }>,
): (gsspCtx: GsspContext) => Promise<GsspResult<P>>;

interface GetServerSideAvsbOptions {
  sdkKey: string;
  cdnHost?: string;
  contextFrom?: (ctx: GsspContext) => EvalContext;
  cookie?: AnonCookieOptions;
}

/** The slice of Next's `GetServerSidePropsContext` this helper needs. */
interface GsspContext {
  req: {
    headers: Record<string, string | string[] | undefined>;
    cookies?: Record<string, string>;
    url?: string;
  };
  res?: {
    setHeader(name: string, value: string | string[]): void;
    getHeader?(name: string): string | string[] | number | undefined;
  };
  params?: Record<string, string | string[]>;
  query?: Record<string, string | string[]>;
  [key: string]: unknown;
}

/** What the optional inner handler receives. */
interface AvsbGsspContext {
  datafile: FlagDatafile;
  /** Evaluated flags as `Flag` objects, methods included, for server logic. */
  flags: Record<string, Flag>;
  context: EvalContext;
  gsspCtx: GsspContext;
}

interface GsspResult<P extends Record<string, unknown>> {
  props: P & { avsbBootstrap: AvsbPagesBootstrap };
}

/** The prop to spread into `<AvsbProvider>` in `_app.tsx`. */
interface AvsbPagesBootstrap {
  sdkKey: string;
  context: EvalContext;
  bootstrap: FlagDatafile;
  serverFlags: SerializedFlagMap;
}
```

### `@avsbhq/next` (client)

```ts
function AvsbProvider(props: AvsbNextProviderProps): ReactElement;

interface AvsbNextProviderProps extends Omit<
  AvsbClientOptions,
  'sdkKey' | 'context' | 'bootstrap'
> {
  sdkKey: string;
  context?: EvalContext;
  bootstrap?: FlagDatafile;
  serverFlags?: SerializedFlagMap;
  children: ReactNode;
}

function readBootstrapBlob(): AvsbBootstrapBlob | null;
function contextFromBlob(blob: AvsbBootstrapBlob | null): EvalContext | undefined;
```

Plus every hook from `@avsbhq/react`: `useFlag`, `useFlagValue`, `useBoolFlag`, `useStringFlag`, `useNumberFlag`, `useJsonFlag`, `useAllFlags`, `useFlagSuspense`, `useFlagChange`, `useFlagSubscription`, `useExposure`, `useAvsbStatus`, `useFlagReady`, `useAvsbClient`, `useAvsbClientSuspense`, `useIdentify`, `useAlias`, `useReset`, `useTrack`. Their signatures and the `Flag<T>` shape are documented in the `@avsbhq/react` README.

### Typed flag keys

Every `flagKey` above is `string` until you generate your keys. Generate them
and it becomes the union of this project's real flag keys, so a typo is a
compile error and your editor completes the list:

```bash
npx @avsbhq/cli codegen --output src/generated/flags.ts
```

The generated file declares your flags twice on purpose: an importable
`FlagValues` interface for payload types, and a `declare global` block that
teaches every hook, and `evaluateFlagServer`, which keys exist. Its important
parts:

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
import { useBoolFlag, useJsonFlag } from '@avsbhq/next';
import type { FlagValues } from './generated/flags';

function useCheckoutFlags() {
  const checkout = useBoolFlag('checkout_v2', false);

  // A JSON flag types its payload from the generated table:
  const theme = useJsonFlag<FlagValues['theme']>('theme', { primary: '#111' });

  // Once the generated file exists, this line stops compiling:
  // 'chekcout_v2' is not a flag key.
  const typo = useBoolFlag('chekcout_v2', false);

  return { checkout, theme };
}
```

The server side narrows the same way: the third argument of
`evaluateFlagServer(datafile, ctx, flagKey, defaultValue)` is the same key type.

Nothing changes for a project that never runs `codegen`: with no generated file
the table is empty, every `flagKey` is exactly `string`, and every call you have
already written compiles unchanged. For a key computed at runtime, such as one
read from a loop over the datafile, widen deliberately with
`key as AvsbFlagKey` (that type is exported from `@avsbhq/core`).

---

## 5. Server Components

`evaluateFlagServer` is a pure function: no network, no state, no side effects. Call it as often as you like inside one render.

```tsx
// app/pricing/page.tsx
import { getDatafile, evaluateFlagServer } from '@avsbhq/next/server';
import type { Flag } from '@avsbhq/next/server';

export default async function PricingPage() {
  const datafile = await getDatafile(process.env.AVSB_SDK_KEY ?? '');
  const context = { kind: 'user' as const, key: 'u_123', plan: 'pro' };
  const flag: Flag<string> = evaluateFlagServer(datafile, context, 'pricing_experiment', 'control');

  if (flag.variationKey === 'usage-based') return <UsageBasedPricing />;
  return <DefaultPricing />;
}
```

`getDatafile` is deduplicated within a request and cached across requests for `revalidate` seconds (60 by default), so ten server components asking for the same key cost one fetch.

### Server evaluation and exposures

Server evaluation fires no exposures, on purpose: an RSC render is not proof a person saw anything. Pair it with `useExposure` in the client component that renders the variation.

```tsx
// app/pricing/page.tsx (server)
export default async function PricingPage() {
  const datafile = await getDatafile(process.env.AVSB_SDK_KEY ?? '');
  const context = { kind: 'user' as const, key: 'u_123' };
  const flag = evaluateFlagServer(datafile, context, 'pricing_experiment', 'control');

  return <PricingPanel variation={flag.variationKey ?? 'control'} />;
}
```

```tsx
// app/PricingPanel.tsx (client)
'use client';
import { useExposure } from '@avsbhq/next';

export function PricingPanel({ variation }: { variation: string }) {
  useExposure('pricing_experiment');
  return variation === 'usage-based' ? <UsageBased /> : <Tiered />;
}
```

Without that pairing, a server-rendered variant is invisible in your results.

---

## 6. Identity

`<AvsbRoot>` uses the `avsb_anon_id` cookie for anonymous visitors, so the server render and the browser bucket the same person. Pass `context` once you know who they are:

```tsx
import { AvsbRoot } from '@avsbhq/next/server';
import { auth } from './lib/auth';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const context = session
    ? { kind: 'user' as const, key: session.userId, plan: session.plan }
    : undefined;

  return (
    <html lang="en">
      <body>
        <AvsbRoot context={context}>{children}</AvsbRoot>
      </body>
    </html>
  );
}
```

Omitting `context` keeps the anonymous cookie. Passing it makes the server and the client evaluate the same identified user.

---

## 7. Middleware

```ts
// middleware.ts
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { withAvsb } from '@avsbhq/next/middleware';
import { server } from './lib/avsbServer';

export const middleware = withAvsb(
  (request: NextRequest) => {
    if (request.nextUrl.pathname === '/old') {
      return NextResponse.redirect(new URL('/new', request.url));
    }
    return undefined;
  },
  {
    server,
    contextFrom: (request: NextRequest) => ({
      kind: 'user',
      key: request.cookies.get('uid')?.value ?? 'anon',
    }),
  },
);

export const config = { matcher: ['/((?!_next|.*\\..*).*)'] };
```

What it guarantees:

- Your middleware's return value passes through untouched. Return nothing and the request continues, exactly like `NextResponse.next()`.
- The anonymous visitor cookie is maintained on whatever response goes out, redirects included.
- With `server` and `contextFrom`, the request runs inside an evaluation scope, so `getRequestClient()` from `@avsbhq/utils` works downstream.

One honest limit: that scope covers the middleware chain, route handlers, and server actions. It does **not** reach React Server Component renders, which Next.js runs separately. For RSCs, evaluate with `evaluateFlagServer` or let `<AvsbRoot>` do it.

For route handlers there is also `nextAppHandler(server, options, handler)`, which opens the same scope per request.

---

## 8. Pages Router

```tsx
// pages/checkout.tsx
import { getServerSideAvsb } from '@avsbhq/next/pages';

export const getServerSideProps = getServerSideAvsb({
  sdkKey: process.env.AVSB_SDK_KEY ?? '',
});

export default function CheckoutPage() {
  return <CheckoutContent />;
}
```

```tsx
// pages/_app.tsx
import { AvsbProvider } from '@avsbhq/next';
import type { AppProps } from 'next/app';

export default function App({ Component, pageProps }: AppProps) {
  const { avsbBootstrap, ...rest } = pageProps;
  return (
    <AvsbProvider {...avsbBootstrap}>
      <Component {...rest} />
    </AvsbProvider>
  );
}
```

`props.avsbBootstrap` is exactly the provider's props: the key, the context that was evaluated, the datafile, and the evaluated values. An inner handler still gets `Flag` objects for server-side branching:

```ts
export const getServerSideProps = getServerSideAvsb(
  { sdkKey: process.env.AVSB_SDK_KEY ?? '' },
  async ({ flags }) => ({
    props: { showBanner: flags['show_banner']?.isEnabled() ?? false },
  }),
);
```

---

## 9. The bootstrap blob

`<AvsbRoot>` writes one, and you rarely need to think about it. Render `<AvsbHydrator>` yourself only when your provider lives outside the `AvsbRoot` subtree:

```tsx
import { AvsbHydrator } from '@avsbhq/next/server';

declare const context: EvalContext;

<AvsbHydrator sdkKey={process.env.AVSB_SDK_KEY ?? ''} context={context} />;
```

It emits a `<script type="application/json" id="__AVSB_BOOTSTRAP__">` element carrying the evaluated flags, the full evaluation context, and (by default) the datafile itself. `<AvsbProvider>` reads it on mount when it was not given props.

The blob is escaped: every `<` becomes a JSON escape, so a flag value containing a script-closing payload cannot end the data block early. Variation values are authored in your dashboard, so this matters: before the escape existed, any org member could put a script on every page of an app using the hydrator.

One thing the blob cannot do is fix the SERVER render: a script tag in the DOM does not exist while the server is rendering. That is what `serverFlags` (a prop) is for, and why `<AvsbRoot>` passes them.

---

## 10. Error handling

```tsx
'use client';
import { useAvsbStatus } from '@avsbhq/next';

export function FlagStatus() {
  const { status, error, degraded } = useAvsbStatus();
  if (status === 'error') return <ErrorBanner message={error?.message} />;
  if (degraded) return <StaleFlagsNotice />;
  return null;
}
```

On the server, a failed datafile fetch does not fail the page. `<AvsbRoot>` logs the reason (status, URL, and the fix), renders anyway, and every read returns the default you passed until the client's own retry succeeds. `getDatafile` throws if you call it yourself, so wrap it if you want the same behaviour by hand.

---

## 11. Tracking

```tsx
'use client';
import { useTrack } from '@avsbhq/next';

const track = useTrack();
track('purchase_completed', { value: 199.0, properties: { plan: 'annual' } });
```

Server-side, use `@avsbhq/node`. It is a separate install (`npm install @avsbhq/node`), not a dependency of this package:

```ts
import { AvsbServer } from '@avsbhq/node';

export const server = new AvsbServer({ sdkKey: process.env.AVSB_SDK_KEY ?? '' });
```

---

## 12. Testing

```tsx
import { render, screen } from '@testing-library/react';
import { AvsbTestProvider } from '@avsbhq/react/testing';
import { CheckoutButton } from './CheckoutButton';

test('renders the new checkout when the flag is on', () => {
  render(
    <AvsbTestProvider flags={{ 'new_checkout_flow': true }}>
      <CheckoutButton />
    </AvsbTestProvider>,
  );
  expect(screen.getByRole('button')).toHaveTextContent('New checkout');
});
```

Server code is tested by calling it:

```ts
import { evaluateFlagServer } from '@avsbhq/next/server';
import { createTestDatafile } from '@avsbhq/react/testing';

const datafile = createTestDatafile({ 'my_flag': true });
const flag = evaluateFlagServer(datafile, { kind: 'user', key: 'u_1' }, 'my_flag', false);
expect(flag.value).toBe(true);
```

---

## 13. Breaking changes in this release

| Change                                                                                                          | What to do                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `avsbNextAppMiddleware` is deleted. It returned an empty 200 for every matched request, which blanked the site. | Use `withAvsb(yourMiddleware?, options?)`. It wraps your middleware and continues the request when there is nothing to do. |
| `AvsbServerProvider` is deleted.                                                                                | Use `<AvsbRoot>`, which also mounts the client provider.                                                                   |
| The bootstrap blob carries the datafile by default (`includeDatafile: true`).                                   | Nothing, unless you were relying on the client fetching it again.                                                          |
| The blob is escaped, and carries the full evaluation context.                                                   | Nothing. Client-side evaluation now sees the attributes the server used.                                                   |
| `getDatafile` requests `{cdnHost}/{sdkKey}/datafile.json`.                                                      | Nothing. The old path did not exist and always failed.                                                                     |
| `getServerSideAvsb` returns `props.avsbBootstrap` (an object), not `props.__avsbBootstrap` (a string).          | Spread it into `<AvsbProvider>` in `_app.tsx`.                                                                             |
| `<AvsbProvider>` requires `sdkKey`.                                                                             | Pass it. The "no sdkKey needed" pattern never worked: without a key the client cannot refresh the datafile.                |
| The client entry is built with a `'use client'` banner.                                                         | You no longer need your own wrapper file to import the provider.                                                           |

---

## 14. Migration

### From LaunchDarkly Next.js

| LaunchDarkly Next.js           | `@avsbhq/next`                                       |
| ------------------------------ | ---------------------------------------------------- |
| `withLDProvider(options)(App)` | `<AvsbRoot>` in `app/layout.tsx`                     |
| `getLDBootstrapData`           | `<AvsbRoot>`, or `getDatafile` plus `<AvsbHydrator>` |
| `useLDClient()`                | `useAvsbClient()`                                    |
| `useFlags()`                   | `useAllFlags()`                                      |
| `useLDFlag('key', default)`    | `useFlag('key', default).value`                      |

### From Statsig Next.js

| Statsig Next.js      | `@avsbhq/next`                                                      |
| -------------------- | ------------------------------------------------------------------- |
| `StatsigProvider`    | `<AvsbRoot>`                                                        |
| `useGate('gate')`    | `useBoolFlag('gate', false).isEnabled()` plus `useExposure('gate')` |
| `useStatsigClient()` | `useAvsbClient()`                                                   |
| `prefetchStatsig`    | `<AvsbRoot>`, or `getDatafile` on the server                        |

---

## 15. Set this up with your AI assistant

Paste this into Claude Code, Cursor, or any coding assistant:

```text
Set up A vs B feature flags in this Next.js project.

1. Run: npx @avsbhq/cli init
   Use my saved CLI login: do not ask me for a token and do not put one in any file.
   It detects Next.js, writes the SDK key into .env.local as AVSB_SDK_KEY, and
   writes an example file.
2. Install @avsbhq/next with this project's package manager.
3. Wrap the tree once in app/layout.tsx with <AvsbRoot> from @avsbhq/next/server,
   then read the flag the example names from a client component.
4. Every getter returns a Flag object, so read .value or call .isEnabled(), and
   always pass a fallback. Reading a flag records nothing: call useExposure(key)
   where the variation is shown.
5. Then run: npx @avsbhq/cli codegen

Done looks like: the app starts, the flag reads without throwing, and avsb init
prints the line confirming it saw the first check-in.
```

`avsb init` ends by waiting for your app's first check-in and printing what it
saw, so the terminal tells you it works rather than the dashboard.
