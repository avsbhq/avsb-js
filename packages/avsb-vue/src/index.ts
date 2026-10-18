// -----------------------------------------------------------------------
// @avsbhq/vue — public surface.
//
// Two more entry points ship alongside this one:
//   @avsbhq/vue/pinia    optional Pinia store (needs the pinia peer)
//   @avsbhq/vue/testing  real provider + real client for tests
// -----------------------------------------------------------------------

// Provider and plugin
export { AvsbProvider } from './AvsbProvider'
export { AvsbPlugin } from './plugin'
export type { AvsbPluginOptions } from './plugin'

// Context: exposed for custom providers and advanced testing
export { AvsbInjectionKey } from './context'
export type { AvsbContextValue } from './context'

// Reading flags
export { useFlag } from './composables/useFlag'
export { useFlagValue } from './composables/useFlagValue'
export { useBoolFlag } from './composables/useBoolFlag'
export { useStringFlag } from './composables/useStringFlag'
export { useNumberFlag } from './composables/useNumberFlag'
export { useJsonFlag } from './composables/useJsonFlag'
export { useAllFlags } from './composables/useAllFlags'

// Readiness and errors
export { useFlagReady } from './composables/useFlagReady'
export { useAvsbStatus } from './composables/useAvsbStatus'
export type { UseAvsbStatusResult } from './composables/useAvsbStatus'

// The client itself
export { useAvsbClient } from './composables/useAvsbClient'

// Identity
export { useIdentify } from './composables/useIdentify'
export { useAlias } from './composables/useAlias'
export { useReset } from './composables/useReset'

// Events
export { useTrack } from './composables/useTrack'
export { useExposure } from './composables/useExposure'
export { useFlagSubscription } from './composables/useFlagSubscription'

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export type { FlagKeyInput } from './internal/bindFlagRef'
export type { VueAvsbClient } from './clientInterface'
export type {
  AvsbStatus,
  AvsbProviderProps,
  AvsbProviderModeAProps,
  AvsbProviderModeBProps,
  AvsbProviderOptions,
} from './types'

export type {
  Flag,
  EvalContext,
  SingleContext,
  MultiContext,
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

// `DecideOption` is a const object as well as a type: re-exported as a value
// so `DecideOption.DISABLE_EXPOSURE` works from this package.
export { DecideOption } from '@avsbhq/core'

export type {
  AvsbClientOptions,
  GetFlagOptions,
  GetAllFlagsOptions,
} from '@avsbhq/browser'
