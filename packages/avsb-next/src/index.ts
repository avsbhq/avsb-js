// Client surface barrel. '@avsbhq/next'.
//
// tsup stamps 'use client' on this entry (see tsup.config.ts): every
// export below is a hook or a client component, and marking the boundary
// here is what removes the hand-written wrapper file the docs used to
// require.

// Provider. Named AvsbProvider so app code imports one name.
export { AvsbNextProvider as AvsbProvider } from './AvsbNextProvider'
export type { AvsbNextProviderProps } from './AvsbNextProvider'
export { readBootstrapBlob, contextFromBlob } from './AvsbNextProvider'

// Every @avsbhq/react hook, re-exported so app code needs one import.
export {
  useFlag,
  useFlagValue,
  useBoolFlag,
  useStringFlag,
  useNumberFlag,
  useJsonFlag,
  useAllFlags,
  useFlagSuspense,
  useFlagChange,
  useFlagSubscription,
  useExposure,
  useAvsbStatus,
  useFlagReady,
  useAvsbClient,
  useAvsbClientSuspense,
  useIdentify,
  useAlias,
  useReset,
  useTrack,
  DecideOption,
} from '@avsbhq/react'

// Types
export type {
  AvsbProviderProps,
  ReactAvsbClient,
  AvsbStatus,
  AvsbStatusState,
  SerializedFlag,
  SerializedFlagMap,
  UseExposureOptions,
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
  Logger,
} from '@avsbhq/react'
