// -----------------------------------------------------------------------
// @avsbhq/solid — public surface.
//
// Naming rule: `create*` registers something reactive (a signal, an effect,
// a subscription with cleanup); `use*` reads the provider context and hands
// back a plain function.
//
// Two more entry points ship alongside this one:
//   @avsbhq/solid/solid-start  server helpers for middleware and SSR
//   @avsbhq/solid/testing      real provider + real client for tests
// -----------------------------------------------------------------------

// Provider
export { AvsbProvider } from './AvsbProvider'

// Context: exposed for custom providers and advanced testing
export { AvsbContext, useAvsbContext, hasAvsbContext } from './context'
export type { AvsbContextValue } from './context'

// Reading flags
export {
  createFlag,
  createFlagValue,
  createBoolFlag,
  createStringFlag,
  createNumberFlag,
  createJsonFlag,
  createAllFlags,
} from './flags'
export type { FlagKeyInput } from './flags'

// Readiness and errors
export { createFlagReady, useAvsbStatus } from './status'
export type { UseAvsbStatusResult } from './status'

// Client, identity, events
export {
  useAvsbClient,
  useTrack,
  useIdentify,
  useAlias,
  useReset,
  createExposure,
  createFlagSubscription,
} from './actions'

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export type { SolidAvsbClient } from './clientInterface'
export type {
  AvsbProviderProps,
  AvsbStatus,
  AvsbStatusValue,
  AvsbClientOptions,
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

export type { GetFlagOptions, GetAllFlagsOptions } from '@avsbhq/browser'

// Note: @avsbhq/core's `createFlag` (which builds Flag<T> data objects) is
// deliberately NOT re-exported here: it would collide with this package's
// `createFlag`, which returns an Accessor<Flag<T>>. Import it from
// '@avsbhq/core' directly if you need to build flag fixtures by hand.
