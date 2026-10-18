# @avsbhq/react-native

React Native SDK for the [A vs B](https://app.avsb.cloud) platform.

Feature flags and A/B experiments for iOS and Android apps. Built on `@avsbhq/browser` and `@avsbhq/react` with React Native-specific adaptations: no dependency on `localStorage` or `EventSource`, support for the Hermes JIT engine, and building blocks for an AsyncStorage-backed datafile and sticky-bucket cache (not wired into the provider yet, see section 9).

---

## 1. Install

```bash
npm install @avsbhq/react-native @react-native-async-storage/async-storage
```

`@avsbhq/react-native` itself is plain JavaScript and needs no linking. `@react-native-async-storage/async-storage` is a native module, so if you install it, run `cd ios && pod install` once for iOS (Expo projects: `npx expo install @react-native-async-storage/async-storage` does this for you).

Peer dependencies:

- `react-native` >= 0.74 (New Architecture compatible)
- `react` >= 18
- `@react-native-async-storage/async-storage` >= 1.18 (optional but recommended for persistence)

---

## 2. Quickstart

```tsx
// App.tsx
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AvsbProvider } from '@avsbhq/react-native';
import type { ReactNode } from 'react';

declare const userId: string;
declare const userPlan: string;

export function App() {
  return (
    <AvsbProvider
      sdkKey="sdk_production_..."
      context={{ kind: 'user', key: userId, plan: userPlan }}
      storage={AsyncStorage}
    >
      <MainNavigator />
    </AvsbProvider>
  );
}
```

`storage` is accepted here but not connected to anything yet: passing it compiles, but nothing is cached or persisted across app restarts today. See section 9 for the real building blocks and what they do and do not do right now.

```tsx
// CheckoutButton.tsx
import { Pressable, Text } from 'react-native';
import { useBoolFlag, useTrack } from '@avsbhq/react-native';

export function CheckoutButton() {
  const flag = useBoolFlag('new_checkout_flow', false);
  const track = useTrack();

  return (
    <Pressable onPress={() => track('checkout_tapped')}>
      <Text>{flag.isEnabled() ? 'New Checkout' : 'Checkout'}</Text>
    </Pressable>
  );
}
```

---

## 3. SDK keys

Get the SDK key for the environment you want to target from your A vs B project's Environments page. The key format is `sdk_<environment>_<id>` (e.g. `sdk_production_clp1a2b3c4d5e6`). SDK keys are scoped to a single environment and grant flag-read access only, so they are safe to embed in your app bundle. Store them in your build config or `.env` files rather than hardcoding in source:

```
AVSB_SDK_KEY=sdk_production_...
```

```ts
import Config from 'react-native-config';
const sdkKey = Config.AVSB_SDK_KEY;
```

---

## 4. Identity

### Provider-level context

Pass a context to `<AvsbProvider>` at startup:

```tsx
export function Root({ children }: { children: ReactNode }) {
  return (
    <AvsbProvider sdkKey={sdkKey} context={{ kind: 'user', key: userId, plan: 'pro' }}>
      {children}
    </AvsbProvider>
  );
}
```

### `useIdentify`

Replace the context after sign-in:

```tsx
import { useIdentify } from '@avsbhq/react-native';

/** Your own signed-in user record. */
interface User {
  id: string;
  email: string;
  plan: string;
}

const identify = useIdentify();

async function onSignIn(user: User) {
  identify({ kind: 'user', key: user.id, email: user.email, plan: user.plan });
}
```

### `useAlias`

Link an anonymous device ID to an identified user on sign-in:

```tsx
import { useAlias } from '@avsbhq/react-native';

const alias = useAlias();

async function onSignIn(deviceId: string, user: User) {
  await alias({ kind: 'user', key: deviceId }, { kind: 'user', key: user.id });
  identify({ kind: 'user', key: user.id, plan: user.plan });
}
```

### `useReset`

Return to an anonymous context on sign-out:

```tsx
import { useReset } from '@avsbhq/react-native';

const reset = useReset();
function onSignOut() {
  reset();
}
```

---

## 5. Multi-context

```tsx
import { Platform } from 'react-native';

declare const deviceId: string;
declare const orgId: string;

identify({
  kind: 'multi',
  user: { kind: 'user', key: userId, plan: 'pro' },
  device: { kind: 'device', key: deviceId, os: Platform.OS },
  organization: { kind: 'organization', key: orgId, tier: 'enterprise' },
});
```

---

## 6. Reading flags

All hooks from `@avsbhq/react` are re-exported and work identically in React Native:

```tsx
import {
  useBoolFlag,
  useStringFlag,
  useNumberFlag,
  useJsonFlag,
  useFlag,
  useFlagValue,
  useAllFlags,
} from '@avsbhq/react-native';

const darkMode = useBoolFlag('dark_mode', false);
const theme = useStringFlag('theme', 'light');
const maxItems = useNumberFlag('max_results', 25);
const config = useJsonFlag<{ retryCount: number }>('api_config', { retryCount: 3 });
```

All return `Flag<T>`:

```ts
const flag = useFlag('new_checkout_flow', false);

flag.value; // the type of the default you passed
flag.isEnabled(); // true if source === 'rule' && value is truthy
flag.variationKey; // 'on' | 'off' | null
flag.source; // 'rule' | 'sticky' | 'default' | ...
flag.reasons; // string[]
```

### Typed flag keys

Every `flagKey` is `string` until you generate your keys. Generate them and it
becomes the union of this project's real flag keys, so a typo is a compile
error and your editor completes the list:

```bash
npx @avsbhq/cli codegen --output src/generated/flags.ts
```

The generated file declares your flags twice on purpose: an importable
`FlagValues` interface for payload types, and a `declare global` block that
teaches every hook which keys exist. Its important parts:

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
import { useBoolFlag, useJsonFlag } from '@avsbhq/react-native';
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

These hooks are the `@avsbhq/react` hooks re-exported, so the generated file
types them exactly the same way here as it does in a web app. The on-device
cache is the one place that still speaks plain strings: it reads flag keys back
out of persisted JSON at runtime, where there is nothing for the compiler to
check.

Nothing changes for a project that never runs `codegen`: with no generated file
the table is empty, every `flagKey` is exactly `string`, and every call you have
already written compiles unchanged. For a key computed at runtime, widen
deliberately with `key as AvsbFlagKey` (that type is exported from
`@avsbhq/core`).

---

## 7. Tracking events

```tsx
const track = useTrack();

track('screen_viewed', {
  value: 1,
  properties: { screen: 'checkout', os: Platform.OS },
});
```

Events are queued and flushed in batches. The flush uses `fetch` with `keepalive: true` where available; falls back to a regular `fetch` call on app background.

---

## 8. Error handling

`AvsbProvider` has no `onError` or `logger` prop today: passing either does not compile against this package's current build. Listen on the client's own event bus instead, which is real and public:

```tsx
import { useEffect } from 'react';
import { useAvsbClient } from '@avsbhq/react-native';

declare function crashlytics(): { recordError(error: Error): void };

export function ErrorReporter() {
  const client = useAvsbClient();

  useEffect(() => {
    // The hook returns null until the provider above has a client.
    return client?.on('error', (err) => {
      crashlytics().recordError(err);
    });
  }, [client]);

  return null;
}
```

Mount `<ErrorReporter />` anywhere under `<AvsbProvider>`. There is no built-in way to plug in a custom logger yet.

---

## 9. SSR / hydration

Not applicable to React Native. There is no server-side rendering; the app renders natively on the device.

There is no built-in cold-start caching yet. The `storage` prop on `AvsbProvider` is accepted but not connected to anything: passing `AsyncStorage` compiles, but the datafile is not cached and every cold start fetches it fresh over the network.

`createAsyncStorageAdapter` and `warmFromStorage` are real, exported, and tested building blocks for a datafile and sticky-bucket cache, shaped for the day `AvsbProvider` reads them automatically:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStorageAdapter, warmFromStorage } from '@avsbhq/react-native';

const adapter = createAsyncStorageAdapter({ storage: AsyncStorage });
// The storage instance comes first: `warmFromStorage` reads its keys, then
// fills the adapter's in-memory sticky cache.
await warmFromStorage(AsyncStorage, adapter); // call before mounting the provider
```

Nothing in this package writes to `adapter` today, since `AvsbProvider` never calls `stickySave` or `datafileSet` on it. Building the adapter and warming it from storage is real, but there is nothing yet to have written that storage in the first place, so this does not by itself make flags survive an app restart.

---

## 10. Graceful shutdown

React Native apps are backgrounded rather than terminated. Flush events when the app moves to the background using `AppState`:

```ts
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useAvsbClient } from '@avsbhq/react-native';

const client = useAvsbClient();

useEffect(() => {
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'background' || state === 'inactive') {
      void client?.flush();
    }
  });
  return () => sub.remove();
}, [client]);
```

When the app is unmounted (unusual but possible in tests or hot reload):

```ts
useEffect(() => {
  return () => {
    void client?.close();
  };
}, [client]);
```

---

## 11. Testing

```tsx
import { render, screen } from '@testing-library/react-native';
import { AvsbTestProvider } from '@avsbhq/react/testing';

test('shows new checkout when enabled', () => {
  render(
    <AvsbTestProvider flags={{ 'new_checkout_flow': true }}>
      <CheckoutButton />
    </AvsbTestProvider>,
  );
  expect(screen.getByText('New Checkout')).toBeTruthy();
});
```

For fluent per-user control:

```ts
import { TestData, createMockClient, flagsFromTestData } from '@avsbhq/test';

const entry = TestData.flag('new_checkout_flow')
  .booleanFlag()
  .variationForUser('u_paid', true)
  .fallthroughVariation(false)
  .build();

const mockClient = createMockClient(flagsFromTestData([entry]));
```

`flagsFromTestData` is the bridge: it turns built entries into the `{ flags, flagsByUser }` MAP the mocks take (breaking change B26). Passing `{ flags: [entry] }` is an array where a map belongs, which does not typecheck and evaluated to defaults at runtime.

---

## 12. Migration

### From LaunchDarkly React Native

| LaunchDarkly React Native                    | `@avsbhq/react-native`                      |
| -------------------------------------------- | ------------------------------------------- |
| `<LDProvider mobileKey="..." context={...}>` | `<AvsbProvider sdkKey="..." context={...}>` |
| `useLDClient()`                              | `useAvsbClient()`                           |
| `useFlags()`                                 | `useAllFlags()`                             |
| `useLDFlag('key', default)`                  | `useFlag('key', default).value`             |
| `ldClient.identify(context)`                 | `useIdentify()(context)`                    |
| `ldClient.track('event')`                    | `useTrack()('event')`                       |
| `ldClient.flush()`                           | `void client?.flush()`                      |

Key differences:

- `useFlag` returns a `Flag<T>` object. Access `.value` for the primitive or use `useFlagValue`.
- The `storage` prop is accepted but not wired yet (section 9), so every cold start fetches the datafile fresh.
- Multi-context is native, with no `LDMultiKindContext` adapter required.
- No EventSource: streaming is unavailable in React Native (polling is used instead).

### From Statsig React Native

| Statsig React Native                         | `@avsbhq/react-native`                                 |
| -------------------------------------------- | ------------------------------------------------------ |
| `<StatsigProvider sdkKey="..." user={...}>`  | `<AvsbProvider sdkKey="..." context={...}>`            |
| `useGate('gate')`                            | `useBoolFlag('gate', false).isEnabled()`               |
| `useExperiment('exp').get('param', default)` | `useFlag('exp', default).value`                        |
| `useStatsigClient()`                         | `useAvsbClient()`                                      |
| `logEvent('event', value, metadata)`         | `useTrack()('event', { value, properties: metadata })` |
