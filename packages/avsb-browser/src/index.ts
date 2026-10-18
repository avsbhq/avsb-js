export { AvsbClient } from './AvsbClient'

// §5.18: engine primitives (evaluateFlag, evaluateAudience, murmurhash3)
// are no longer re-exported here. Import from @avsbhq/core/engine directly.

export { isConditionGroup } from '@avsbhq/core'
export type {
  FlagEvaluationDetails,
  FlagDatafile,
  FlagDatafileEntry,
  FlagDatafileVariation,
  FlagDatafileOverride,
  FlagDatafileRule,
  FlagDatafileAudience,
  ConditionGroup,
  Condition,
  EvalContext,
  SingleContext,
  MultiContext,
  ExposureEvent,
  MetricEvent,
  Flag,
  InitResult,
  TrackPayload,
  EvaluationSource,
  RuleType,
  Logger,
  ClientEventMap,
  ClientEventName,
  AvsbFlagKey,
  AvsbFlagValue,
} from '@avsbhq/core'
// `DecideOption` is a const object AND a type, so it is re-exported as a
// value: the README teaches `DecideOption.DISABLE_EXPOSURE`, which a
// type-only export cannot serve.
export { DecideOption } from '@avsbhq/core'

// Logging. Re-exported so a customer configuring SDK logs has one import
// path (the README documented these as browser exports while they were
// only reachable from @avsbhq/core).
export {
  createLogger,
  consoleLogger,
  consoleTransport,
  noopLogger,
} from '@avsbhq/core'
export type { LogLevel, LogTransport, LoggerOptions } from '@avsbhq/core'
export { isDevEnvironment } from './logger'
export type { BrowserLogLevel } from './logger'

export type {
  AvsbClientOptions,
  SdkWrapperIdentity,
  BrowserEventOptions,
  GetFlagOptions,
  GetAllFlagsOptions,
  Tracker,
} from './types'

// Network error shapes, so `onError` handlers can branch on the cause
// instead of matching message strings.
export { AvsbNetworkError, AvsbTimeoutError } from './net'

// §6 — utils binding shape (runtime instance is exposed on AvsbClient).
export type { AvsbUtils } from '@avsbhq/utils'

// Bootstrap handoff types. `applySnapshot(snapshot: FlagSnapshot)` is on the
// public class and `client.utils.hydrateBootstrap(blob)` returns the result
// shape, so naming either one should not require a second dependency.
export type {
  FlagSnapshot,
  BootstrapBlob,
  HydrateBootstrapResult,
} from '@avsbhq/utils'
