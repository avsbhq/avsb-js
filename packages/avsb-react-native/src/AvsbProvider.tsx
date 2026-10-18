'use client'
// AvsbProvider for React Native: @avsbhq/react's provider in Mode A.
//
// N1-5 (production QA 2026-10-01). The published 1.0.2 built its own
// AvsbClient in a ref and handed it to @avsbhq/react in Mode B (injection),
// so:
//   - the React provider treated the client as the caller's and never
//     closed it: after unmount its timers kept the JS runtime busy forever;
//   - the client was created during render, which StrictMode's double mount
//     runs twice, leaking the first one;
//   - options other than sdkKey and context never reached the client in the
//     published build (pollingInterval: 5000 was silently dropped).
// Mode A fixes all three at once: the React provider builds the client in an
// effect, closes it on unmount (and on StrictMode's simulated unmount), and
// passes every AvsbClientOptions field to the constructor. The heartbeat
// names @avsbhq/react-native at its own version.
//
// `storage` is still accepted and not wired: AvsbClient has no
// post-construction storage slot yet. createAsyncStorageAdapter and
// warmFromStorage are the supported way to persist a datafile today (see the
// README). Tracked in futureWorks.md as [sdk-react-native/provider-storage-prop].

import type { ReactElement, ReactNode } from 'react'
import type { AvsbClientOptions } from '@avsbhq/browser'
import { AvsbProvider as ReactAvsbProvider } from '@avsbhq/react'
import type { AsyncStorageLike } from './asyncStorageCache'
import { SDK_TYPE, SDK_VERSION } from './version'

/**
 * Client options this provider passes straight through: everything
 * `AvsbClient` accepts except the key and the context, which have their own
 * props below.
 */
type PassthroughClientOptions = Omit<AvsbClientOptions, 'sdkKey' | 'context'>

export interface AvsbRNProviderProps extends PassthroughClientOptions {
  /** SDK key from the AvsB dashboard. */
  sdkKey: string
  /** Initial evaluation context (user, org, device etc.). */
  context?: AvsbClientOptions['context']
  /**
   * Accepted for forward compatibility and NOT wired yet: the client keeps
   * its datafile in memory only. Use createAsyncStorageAdapter plus
   * warmFromStorage and pass the stored datafile as `bootstrap` to start
   * from a persisted copy.
   */
  storage?: AsyncStorageLike
  children: ReactNode
}

/**
 * React Native flavour of AvsbProvider. Builds, owns and closes one client,
 * exactly like `<AvsbProvider sdkKey=...>` from @avsbhq/react.
 */
export function AvsbProvider({
  storage: _storage,
  children,
  ...clientOptions
}: AvsbRNProviderProps): ReactElement {
  return (
    <ReactAvsbProvider
      {...clientOptions}
      wrapper={clientOptions.wrapper ?? { sdkType: SDK_TYPE, sdkVersion: SDK_VERSION }}
    >
      {children}
    </ReactAvsbProvider>
  )
}
