// -----------------------------------------------------------------------
// @avsbhq/react — public surface.
//
// Every export below is launch-final. Hooks are the public API; the
// context, the store binding, and the status machine are internal.
// -----------------------------------------------------------------------

// Provider
export { AvsbProvider } from './AvsbProvider'

// Flag hooks — rendering (useSyncExternalStore, exposure-free)
export { useFlag } from './useFlag'
export { useFlagValue } from './useFlagValue'
export { useBoolFlag } from './useBoolFlag'
export { useStringFlag } from './useStringFlag'
export { useNumberFlag } from './useNumberFlag'
export { useJsonFlag } from './useJsonFlag'
export { useAllFlags } from './useAllFlags'

// Flag hooks — Suspense
export { useFlagSuspense } from './useFlagSuspense'

// Flag hooks — side-effect (non-rendering)
export { useFlagChange } from './useFlagChange'
export { useFlagSubscription } from './useFlagSubscription'
export { useExposure } from './useExposure'

// Status hooks
export { useAvsbStatus } from './useAvsbStatus'
export { useFlagReady } from './useFlagReady'

// Client hooks
export { useAvsbClient } from './useAvsbClient'
export { useAvsbClientSuspense } from './useAvsbClientSuspense'

// Identity hooks
export { useIdentify } from './useIdentify'
export { useAlias } from './useAlias'
export { useReset } from './useReset'

// Tracking
export { useTrack } from './useTrack'

// Server-evaluated values (SSR): build the map on the server, hand it to
// <AvsbProvider serverFlags={...}>, and every hook's server snapshot uses
// it. @avsbhq/next fills this in for you.
export { toSerializedFlag, toSerializedFlagMap, reviveServerFlags } from './serverFlags'

// -----------------------------------------------------------------------
// Values that are also types
// -----------------------------------------------------------------------

// `DecideOption` is a const object AND a type, so it must be a VALUE
// export: the documented `decideOptions: [DecideOption.DISABLE_EXPOSURE]`
// cannot be served by a type-only re-export (report 03 §2).
export { DecideOption } from '@avsbhq/browser'

// -----------------------------------------------------------------------
// Type re-exports
// -----------------------------------------------------------------------

export type { AvsbProviderProps, AvsbProviderSharedProps } from './types'
export type { ReactAvsbClient } from './clientInterface'
export type { AvsbStatus, AvsbStatusState } from './providerStatus'
export type { SerializedFlag, SerializedFlagMap } from './serverFlags'
export type { UseExposureOptions } from './useExposure'

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

export type {
  AvsbClientOptions,
  GetFlagOptions,
  GetAllFlagsOptions,
} from '@avsbhq/browser'
