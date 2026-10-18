// -----------------------------------------------------------------------
// @avsbhq/svelte — public surface.
//
// Four more entry points ship alongside this one:
//   @avsbhq/svelte/AvsbProvider.svelte  the provider component (raw source)
//   @avsbhq/svelte/runes                $state accessors for Svelte 5
//   @avsbhq/svelte/sveltekit            server helpers for hooks and load
//   @avsbhq/svelte/testing              real provider + real client for tests
// -----------------------------------------------------------------------

// Provider, programmatic form. The SFC is a wrapper around this.
export { createAvsbContext, buildAvsbContext } from './AvsbProvider'
export type {
  CreateAvsbContextOptions,
  CreateAvsbContextResult,
} from './AvsbProvider'

// Context: exposed so stores can be used outside a component
export {
  AVSB_CONTEXT_KEY,
  useAvsbContext,
  setAvsbContext,
  hasAvsbContext,
} from './context'
export type { AvsbContextValue } from './context'

// Flag stores
export {
  flag,
  flagValue,
  boolFlag,
  stringFlag,
  numberFlag,
  jsonFlag,
  allFlags,
} from './flags'

// Readiness and errors
export { flagReady, avsbStatus } from './status'

// Client access, identity, events
export {
  getAvsbClient,
  getTrack,
  getIdentify,
  getAlias,
  getReset,
  getExposure,
  subscribeFlag,
} from './actions'

// -----------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------

export type { SvelteAvsbClient } from './clientInterface'
export type { AvsbProviderProps, AvsbStatus, AvsbStatusValue } from './types'

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
