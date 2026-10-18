import type { ReactNode } from 'react'
import type { AvsbClientOptions } from '@avsbhq/browser'
import type { ReactAvsbClient } from './clientInterface'
import type { SerializedFlagMap } from './serverFlags'

// -----------------------------------------------------------------------
// Provider props. Two modes, one component.
//
//   Mode A (convenience): pass `sdkKey` and any other AvsbClientOptions.
//     The provider creates the client, owns it, and closes it on unmount.
//
//   Mode B (injection): pass a pre-built `client`.
//     The provider never closes it. You own its lifecycle.
//
// Both modes accept `serverFlags`, the server-evaluated values that make
// server-rendered HTML show real flag values instead of defaults.
// -----------------------------------------------------------------------

/** Props both modes share. */
export interface AvsbProviderSharedProps {
  children: ReactNode
  /**
   * Flags already evaluated on the server, as data.
   *
   * Every hook's `getServerSnapshot` reads from this, so the server render
   * and the hydration render produce identical markup. In Next.js,
   * `<AvsbRoot>` and `getServerSideAvsb` fill it in for you; in a custom
   * SSR setup, build it with `toSerializedFlagMap(...)`.
   */
  serverFlags?: SerializedFlagMap | null
}

export type AvsbProviderProps =
  | (AvsbClientOptions & AvsbProviderSharedProps & { client?: never })
  | ({ client: ReactAvsbClient } & AvsbProviderSharedProps)

// -----------------------------------------------------------------------
// Re-exports so consumers have one import path for the types they need.
// -----------------------------------------------------------------------

export type { AvsbClientOptions, GetFlagOptions, GetAllFlagsOptions } from '@avsbhq/browser'

export type {
  Flag,
  EvalContext,
  SingleContext,
  MultiContext,
  ContextMeta,
  TrackPayload,
  InitResult,
  ClientEventMap,
  ClientEventName,
  EvaluationSource,
  RuleType,
  FlagDatafile,
  FlagDatafileEntry,
  FlagDatafileVariation,
  FlagDatafileOverride,
  FlagDatafileRule,
  FlagDatafileAudience,
  Logger,
} from '@avsbhq/core'

// `DecideOption` is a const object AND a type, so it is exported as a
// VALUE from ./index. A type-only re-export here is what made
// `DecideOption.DISABLE_EXPOSURE` unreachable from this package
// (report 03 §2 typing quality).
