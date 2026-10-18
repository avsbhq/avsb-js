# @avsbhq/react

React SDK for the [A vs B](https://app.avsb.cloud) platform.

Wrap your tree in `<AvsbProvider>` and read feature flags with hooks. Built on `@avsbhq/browser`, so a component re-renders when the flag it reads changes, and only then.

---

## 1. Install

```bash
npm install @avsbhq/react
```

React 18 or later, as a peer dependency. `@avsbhq/browser` ships as a runtime dependency, so there is nothing else to install.

---

## 2. Quickstart

```tsx
// app.tsx
import { AvsbProvider } from '@avsbhq/react';
import type { ReactNode } from 'react';

declare const userId: string;

export function App({ children }: { children: ReactNode }) {
  return (
    <AvsbProvider
      sdkKey={import.meta.env.VITE_AVSB_SDK_KEY as string}
      context={{ kind: 'user', key: userId, plan: 'pro' }}
    >
      {children}
    </AvsbProvider>
  );
}
```

```tsx
// CheckoutButton.tsx
import { useBoolFlag, useExposure, useTrack } from '@avsbhq/react';
import type { Flag } from '@avsbhq/react';

export function CheckoutButton() {
  const newCheckout: Flag<boolean> = useBoolFlag('new_checkout_flow', false);
  const track = useTrack();

  // Reading a flag never fires an exposure. This is what records that the
  // visitor saw the variation.
  useExposure('new_checkout_flow');

  return (
    <button onClick={() => track('checkout_clicked', { properties: { location: 'header' } })}>
      {newCheckout.isEnabled() ? 'Start checkout (new)' : 'Buy now'}
    </button>
  );
}
```

Two rules make everything else fall out:

1. **Reads never fire exposures.** React retries, discards, and replays renders, so a render must never write analytics. `useExposure` fires one exposure per flag per mounted view, from an effect.
2. **Every read needs a default.** It is what you get before the SDK is ready, when the key does not exist, and when the platform's type does not match.

---

## 3. SDK keys

Copy the key for the environment you want from **Environments** in your A vs B project's sidebar. The format is `sdk_<environment>_<id>`, for example `sdk_production_ttqm0eaj4vth1krcb2xn`.

```
VITE_AVSB_SDK_KEY=sdk_production_...
NEXT_PUBLIC_AVSB_SDK_KEY=sdk_production_...
```

SDK keys are scoped to a single environment and grant flag reads only: they cannot write to your project or read another environment. They are safe to embed in browser bundles within those bounds.

Rendering `<AvsbProvider>` without one is not silent: no client is built, `useAvsbStatus()` reports `'error'`, and the message says where the real key lives.

---

## 4. The whole type surface

Every export, with its real signature. The signatures below name the package's own types, and React's. Both come from here:

```ts
import type {
  AvsbClientOptions,
  EvalContext,
  EvaluationSource,
  Flag,
  ReactAvsbClient,
  RuleType,
  SerializedFlagMap,
  TrackPayload,
} from '@avsbhq/react';
import type { ReactElement, ReactNode } from 'react';
```

### Provider

```ts
function AvsbProvider(props: AvsbProviderProps): ReactElement;

type AvsbProviderProps =
  | (AvsbClientOptions & AvsbProviderSharedProps & { client?: never })
  | ({ client: ReactAvsbClient } & AvsbProviderSharedProps);

interface AvsbProviderSharedProps {
  children: ReactNode;
  serverFlags?: SerializedFlagMap | null;
}
```

Two modes:

- **Mode A**, `sdkKey` plus any other `AvsbClientOptions` (`context`, `bootstrap`, `pollingInterval`, `logLevel`, and so on, all documented in `@avsbhq/browser`). The provider builds the client, owns it, and closes it when it unmounts.
- **Mode B**, a pre-built `client`. The provider never closes it: you own its lifecycle.

The owned client is created in a layout effect, not during render, so React StrictMode's double-invoked effects get a fresh live client rather than a closed one. Changing `sdkKey` or `cdnHost` rebuilds it; changing `context` calls `identify` instead, which keeps the visitor's queued events.

### Reading flags

```ts
function useFlag<T>(flagKey: string, defaultValue: T): Flag<T>;
function useFlagValue<T>(flagKey: string, defaultValue: T): T;
function useBoolFlag(flagKey: string, defaultValue: boolean): Flag<boolean>;
function useStringFlag(flagKey: string, defaultValue: string): Flag<string>;
function useNumberFlag(flagKey: string, defaultValue: number): Flag<number>;
function useJsonFlag<T>(flagKey: string, defaultValue: T): Flag<T>;
function useAllFlags(): Record<string, Flag>;
function useFlagSuspense<T>(flagKey: string, defaultValue: T): Flag<T>;
```

The four typed hooks check the value against the type the platform declared for that flag. **On a mismatch they never throw:** one warning names the flag, the getter, and the declared type, and you get your `defaultValue` back with `source: 'not_found'`. `useJsonFlag<T>` checks only that the flag is declared as JSON; validate the shape of `T` yourself if it crosses a trust boundary.

`useFlag<T>` runs no runtime check: whatever the datafile says is returned, typed as `T`.

### Status and readiness

```ts
function useFlagReady(): boolean;
function useAvsbStatus(): {
  status: 'loading' | 'ready' | 'error';
  error?: Error;
  degraded: boolean;
};
```

### Side effects and identity

```ts
function useExposure(flagKey: string, options?: UseExposureOptions): void;
interface UseExposureOptions {
  enabled?: boolean;
}

function useTrack(): (eventKey: string, payload?: TrackPayload) => void;
function useIdentify(): (context: EvalContext) => void;
function useAlias(): (previous: EvalContext, next: EvalContext) => Promise<void>;
function useReset(): () => void;

function useFlagChange(
  callback: (data: { flagKey: string; previousValue: unknown; newValue: unknown }) => void,
): void;
function useFlagSubscription(flagKey: string, callback: (flag: Flag) => void): void;
```

The four callbacks returned by `useTrack`, `useIdentify`, `useAlias`, and `useReset` are referentially stable: they never change identity, so they are safe in a dependency array.

### Client access

```ts
function useAvsbClient(): ReactAvsbClient | null;
function useAvsbClientSuspense(): ReactAvsbClient;
```

### Server-evaluated values

```ts
interface SerializedFlag {
  value: unknown;
  variationKey: string | null;
  source: EvaluationSource;
  ruleId: string | null;
  ruleType: RuleType | null;
  reasons: string[];
  evaluatedAt: number;
}
type SerializedFlagMap = Record<string, SerializedFlag>;

function toSerializedFlag(flag: Flag<unknown>): SerializedFlag;
function toSerializedFlagMap(flags: Record<string, Flag<unknown>>): SerializedFlagMap;
function reviveServerFlags(serialized: SerializedFlagMap | null | undefined): Record<string, Flag>;
```

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

The object is frozen, and the same object comes back on every render until that flag's value actually changes.

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

| Member             | Meaning                                                                          | `isEnabled()`   | `exists()` |
| ------------------ | -------------------------------------------------------------------------------- | --------------- | ---------- |
| `datafileOverride` | A per-user override configured in the dashboard matched.                         | value-dependent | true       |
| `runtimeOverride`  | `setOverrideForUser` or `setGlobalOverride` matched.                             | value-dependent | true       |
| `sticky`           | A previously stored assignment was reused.                                       | value-dependent | true       |
| `rule`             | A targeting rule or A/B rule matched.                                            | value-dependent | true       |
| `holdout`          | The visitor is in a holdout.                                                     | value-dependent | true       |
| `bandit`           | A bandit rule picked the variation.                                              | value-dependent | true       |
| `default`          | The flag exists, nothing matched, so its default variation was served.           | false           | true       |
| `disabled`         | The flag exists but is switched off in this environment.                         | false           | true       |
| `not_found`        | The datafile loaded and does not contain this key. Check the key name.           | false           | false      |
| `not_ready`        | The SDK has no datafile yet, or a hook ran before the provider's client existed. | false           | false      |

"value-dependent" means `isEnabled()` is `Boolean(flag.value)`: a real decision was made, so the answer is whatever that decision produced.

### Typed flag keys

Every `flagKey` above is `string` until you generate your keys. Generate them
and it becomes the union of this project's real flag keys, so a typo is a
compile error and your editor completes the list:

```bash
npx @avsbhq/cli codegen --output src/generated/flags.ts
```

The generated file declares your flags twice on purpose: an importable
`FlagValues` interface for payload types, and a `declare global` block that
teaches every hook in this package which keys exist. Its important parts:

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
import { useBoolFlag, useJsonFlag } from '@avsbhq/react';
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

Nothing changes for a project that never runs `codegen`: with no generated file
the table is empty, every `flagKey` is exactly `string`, and every call you have
already written compiles unchanged. For a key computed at runtime, widen
deliberately with `key as AvsbFlagKey` (that type is exported from
`@avsbhq/core`).

---

## 5. Identity

```tsx
import { useIdentify, useAlias, useReset } from '@avsbhq/react';
import type { EvalContext } from '@avsbhq/react';

declare const user: { id: string; email: string; plan: string };
declare const anonymousKey: string;

function SignInButtons() {
  const identify = useIdentify();
  const alias = useAlias();
  const reset = useReset();

  async function onSignIn(): Promise<void> {
    // Stitch the anonymous session to the identified one, then switch.
    await alias({ kind: 'user', key: anonymousKey }, { kind: 'user', key: user.id });
    const context: EvalContext = {
      kind: 'user',
      key: user.id,
      email: user.email,
      plan: user.plan,
    };
    identify(context);
  }

  return (
    <div>
      <button onClick={() => void onSignIn()}>Sign in</button>
      <button onClick={reset}>Sign out</button>
    </div>
  );
}
```

`reset()` rotates to a NEW anonymous identity and clears runtime overrides, so the next anonymous session is genuinely a different visitor rather than the person who just signed out.

Changing the `context` prop on `<AvsbProvider>` has the same effect as calling `identify`: the provider compares the context by value, so a fresh object literal with the same fields does nothing.

### Multi-context

```tsx
function WorkspaceSwitcher() {
  const identify = useIdentify();

  function onSwitchWorkspace(): void {
    identify({
      kind: 'multi',
      user: { kind: 'user', key: 'u_123', plan: 'pro' },
      organization: { kind: 'organization', key: 'org_456', tier: 'enterprise' },
    });
  }

  return <button onClick={onSwitchWorkspace}>Switch workspace</button>;
}
```

Rules can then target any kind: a rule might bucket on `user.key` while matching an audience condition on `organization.tier`.

---

## 6. Exposures, and why reads are free

```tsx
import { useBoolFlag, useExposure } from '@avsbhq/react';

function Checkout() {
  const flag = useBoolFlag('checkout_v2', false);
  useExposure('checkout_v2');
  return flag.isEnabled() ? <CheckoutV2 /> : <CheckoutV1 />;
}
```

- Rendering hooks read a cached, side-effect-free snapshot. No exposure, no evaluation event, whatever React does with the render.
- `useExposure` fires once per flag per mounted view, after flags are readable, so an exposure is never recorded against a default value.
- Remounting the component counts again: that is a new view.
- Hold it back until the variation is really on screen with `useExposure(key, { enabled: isOpen })`.

React StrictMode double-invokes effects in development. The hook guards against that, so development fires once as well.

---

## 7. Status, loading, and failure

```tsx
import { useAvsbStatus, useFlagReady } from '@avsbhq/react';
import type { ReactNode } from 'react';

function Gate({ children }: { children: ReactNode }) {
  const ready = useFlagReady();
  const { status, error, degraded } = useAvsbStatus();

  if (status === 'error') return <ErrorBanner message={error?.message} />;
  if (!ready) return <Skeleton />;
  return (
    <>
      {degraded ? <StaleFlagsNotice /> : null}
      {children}
    </>
  );
}
```

| State                     | What it means                                                                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'loading'`               | Nothing is readable yet. Reads return your default with `source: 'not_ready'`.                                                                     |
| `'ready'`                 | Reads answer with real values.                                                                                                                     |
| `'ready'` plus `degraded` | A cached or bootstrapped datafile is being served because a refresh failed. Flags work and may be stale. It clears itself when a refresh succeeds. |
| `'error'`                 | The init attempt finished with nothing to serve. `error.message` names the status, the URL, and the fix. A later poll can still rescue it.         |

A degraded SDK is never reported as an error: flags are answering.

---

## 8. Suspense

```tsx
import { Suspense } from 'react';
import { useFlagSuspense } from '@avsbhq/react';

function CheckoutFeature() {
  const flag = useFlagSuspense('checkout_v2', false);
  return flag.isEnabled() ? <CheckoutV2 /> : <Checkout />;
}

export function Page() {
  return (
    <Suspense fallback={<Skeleton />}>
      <CheckoutFeature />
    </Suspense>
  );
}
```

It suspends on the provider leaving its loading state, so a failed init gives you the component back on defaults instead of a fallback that never resolves. It does not suspend at all when `serverFlags` already contains the key.

---

## 9. Server rendering

Two things have to be true for a server-rendered page not to flash defaults: the browser client must start with the datafile in hand, and the server-rendered HTML must contain the same values the client will compute.

```ts
// Server
import { AvsbClient } from '@avsbhq/browser';
import { fetchDatafile } from '@avsbhq/browser/server';
import { toSerializedFlagMap } from '@avsbhq/react';
import type { EvalContext, FlagDatafile } from '@avsbhq/react';

declare const context: EvalContext;
const sdkKey: string = process.env.AVSB_SDK_KEY ?? '';

const datafile: FlagDatafile | null = await fetchDatafile(sdkKey);
const client = new AvsbClient({
  sdkKey,
  context,
  ...(datafile ? { bootstrap: datafile } : {}),
  autoRefresh: false,
});
const serverFlags = toSerializedFlagMap(client.getAllFlags());
```

```tsx
// Client
export function Root({ children }: { children: ReactNode }) {
  return (
    <AvsbProvider
      sdkKey={sdkKey}
      context={context}
      bootstrap={datafile ?? undefined}
      serverFlags={serverFlags}
    >
      {children}
    </AvsbProvider>
  );
}
```

`serverFlags` feeds every hook's server snapshot, so the HTML and the hydration render agree by construction. `bootstrap` removes the client's first network request.

For Next.js this is one component: `<AvsbRoot>` in `@avsbhq/next` does the fetch, the anonymous cookie, the evaluation, and the provider.

---

## 10. Testing

```tsx
import { render, screen } from '@testing-library/react';
import { AvsbTestProvider } from '@avsbhq/react/testing';
import { CheckoutButton } from './CheckoutButton';

test('shows the new checkout when the flag is on', () => {
  render(
    <AvsbTestProvider flags={{ 'new_checkout_flow': true }}>
      <CheckoutButton />
    </AvsbTestProvider>,
  );
  expect(screen.getByRole('button')).toHaveTextContent('Start checkout (new)');
});
```

```ts
function AvsbTestProvider(props: {
  flags?: Record<string, boolean | string | number | object | null>;
  datafile?: FlagDatafile;
  context?: EvalContext;
  children: ReactNode;
}): ReactElement;

function createTestClient(
  flags?: Record<string, boolean | string | number | object | null>,
  options?: { datafile?: FlagDatafile; context?: EvalContext },
): AvsbClient;

function createTestDatafile(
  flags: Record<string, boolean | string | number | object | null>,
  options?: { sdkKey?: string; environmentKey?: string },
): FlagDatafile;
```

There is no mock client here. The flags map becomes a real datafile, the real client bootstraps from it, and the real provider owns it, so a test exercises the same code path production does. Flags are readable on the first render, with no `await`, and nothing touches the network or `localStorage`.

---

## 11. Migration

### From LaunchDarkly React

| LaunchDarkly React                | `@avsbhq/react`                                                    |
| --------------------------------- | ------------------------------------------------------------------ |
| `<LDProvider clientSideID="...">` | `<AvsbProvider sdkKey="...">`                                      |
| `useLDClient()`                   | `useAvsbClient()`                                                  |
| `useFlags()`                      | `useAllFlags()`                                                    |
| `useLDFlag('key', default)`       | `useFlag('key', default).value`, or `useFlagValue('key', default)` |
| `ldClient.identify(context)`      | `useIdentify()(context)`                                           |
| `ldClient.track('event')`         | `useTrack()('event')`                                              |
| `withLDProvider(options)(App)`    | `<AvsbProvider ...>`, no HOC                                       |

Key differences:

- Hooks return a `Flag<T>` object, not a raw value. Use `.value`, or `useFlagValue`.
- Every hook requires an explicit default value.
- Multi-context is native: pass `{ kind: 'multi', user: ..., organization: ... }`.
- Exposures are explicit. `useExposure(key)` is what records that a variation was shown.

### From Statsig React

| Statsig React                                | `@avsbhq/react`                                                     |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `<StatsigProvider sdkKey="...">`             | `<AvsbProvider sdkKey="...">`                                       |
| `useGate('gate')`                            | `useBoolFlag('gate', false).isEnabled()` plus `useExposure('gate')` |
| `useExperiment('exp').get('param', default)` | `useFlag('exp', default).value`                                     |
| `useStatsigClient()`                         | `useAvsbClient()`                                                   |
| `logEvent('event', value, metadata)`         | `useTrack()('event', { value, properties: metadata })`              |

Statsig's split between auto-logging and deferred-logging hooks maps onto one rule here: reads never log, `useExposure` does.

---

## 12. Breaking changes in this release

| Change                                                                         | What to do                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Typed hooks no longer fire an exposure per render.                             | Add `useExposure(flagKey)` where the variation is shown, or exposure counts drop to zero.                      |
| `useAvsbStatus()` returns `degraded` alongside `status` and `error`.           | Nothing, unless you want to show the stale-values warning.                                                     |
| `status: 'error'` now means "nothing to serve", not "an error event happened". | A degraded SDK reports `'ready'` with `degraded: true`.                                                        |
| The owned client is created in an effect, so the first render has no client.   | Nothing. Reads return your default for that render; with `bootstrap` or `serverFlags` they return real values. |
| `<AvsbProvider>` accepts `serverFlags`.                                        | Optional, and what makes server-rendered HTML show real values.                                                |
| `DecideOption` is exported as a value.                                         | It was unreachable from this package before.                                                                   |
| `@avsbhq/react/testing` replaces the old testing examples.                     | `AvsbTestProvider` takes a `flags` map.                                                                        |

---

## 13. Set this up with your AI assistant

Paste this into Claude Code, Cursor, or any coding assistant:

```text
Set up A vs B feature flags in this React project.

1. Run: npx @avsbhq/cli init
   Use my saved CLI login: do not ask me for a token and do not put one in any file.
   It detects React, writes the SDK key into the environment file this project's
   bundler reads (VITE_AVSB_SDK_KEY for Vite), and writes an example component.
2. Install @avsbhq/react with this project's package manager.
3. Mount <AvsbProvider> once at the root with that key and a context of
   { kind: 'user', key: <your user id> }, then read the flag the example names.
4. Every getter returns a Flag object, so read .value or call .isEnabled(), and
   always pass a fallback. Reading a flag records nothing: call useExposure(key)
   where the variation is shown.
5. Then run: npx @avsbhq/cli codegen

Done looks like: the app starts, the flag reads without throwing, and avsb init
prints the line confirming it saw the first check-in.
```

`avsb init` ends by waiting for your app's first check-in and printing what it
saw, so the terminal tells you it works rather than the dashboard.
