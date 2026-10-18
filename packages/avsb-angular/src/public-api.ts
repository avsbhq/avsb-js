// ---------------------------------------------------------------------------
// @avsbhq/angular: the whole public surface.
//
// Angular SDK for the A vs B feature flag and experimentation platform.
// ---------------------------------------------------------------------------

// Configuration
export { AvsbModule, provideAvsb, AVSB_TEMPLATE_FEATURES } from './avsb.module'
export { AVSB_CONFIG, AVSB_CLIENT } from './avsb.tokens'

// Service
export { AvsbService } from './avsb.service'

// Template features
export { AvsbFlagDirective } from './flag.directive'
export { AvsbExposureDirective } from './exposure.directive'
export { AvsbFlagPipe } from './pipes/avsb-flag.pipe'
export { AvsbFlagStatePipe } from './pipes/avsb-flag-state.pipe'

// Observable helpers
export {
  avsbFlag$,
  avsbFlagValue$,
  avsbBoolFlag$,
  avsbStringFlag$,
  avsbNumberFlag$,
  avsbJsonFlag$,
  avsbAllFlags$,
  avsbStatus$,
  avsbReady$,
  avsbError$,
  avsbDegraded$,
  avsbTrack,
  avsbIdentify,
  avsbAlias,
  avsbReset,
  avsbRecordExposure,
} from './rxjs-helpers'

// Signal helpers
export {
  avsbFlagSignal,
  avsbFlagValueSignal,
  avsbBoolFlagSignal,
  avsbStringFlagSignal,
  avsbNumberFlagSignal,
  avsbJsonFlagSignal,
  avsbAllFlagsSignal,
  avsbStatusSignal,
  avsbReadySignal,
  avsbErrorSignal,
  avsbDegradedSignal,
} from './signal-helpers'

// Types owned by this package
export type { AvsbConfig, AvsbStatus, AvsbInjectOptions } from './types'
export type { AngularAvsbClient } from './clientInterface'

// Types re-exported from the SDK core, so one import path covers a whole
// component file.
export type {
  AvsbClientOptions,
  GetFlagOptions,
  GetAllFlagsOptions,
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
} from './types'

// `DecideOption` is a const object AND a type, so it ships as a value:
// `DecideOption.DISABLE_EXPOSURE` has to exist at runtime.
export { DecideOption } from '@avsbhq/core'

// Flag factories, for building a stand-in client in tests.
export { createFlag, notFoundFlag, notReadyFlag } from '@avsbhq/core'
