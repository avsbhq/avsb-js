// =====================================================================
// @avsbhq/edge — main entry point.
//
// Runtime-specific adapters live on subpath exports:
//   @avsbhq/edge/cloudflare  @avsbhq/edge/vercel  @avsbhq/edge/fastly
//   @avsbhq/edge/netlify     @avsbhq/edge/deno    @avsbhq/edge/bun
//   @avsbhq/edge/lambda
//
// Everything here is runtime-agnostic: the client, its types, and the
// request-to-context helpers a custom `contextFrom` is built from.
// =====================================================================

export { AvsbEdgeClient } from './AvsbEdgeClient'

export type {
  EdgeClientOptions,
  EdgeErrorSource,
  EdgeLogLevel,
  EdgeRequest,
  EdgeResponse,
  GetAllFlagsOptions,
  GetFlagOptions,
  AdapterClientOptions,
} from './types'

// Shared core types, re-exported so a consumer imports everything the edge
// client speaks from one path.
export type {
  EvalContext,
  SingleContext,
  MultiContext,
  Flag,
  FlagDatafile,
  FlagDatafileEntry,
  FlagDatafileVariation,
  FlagDatafileRule,
  FlagDatafileAudience,
  InitResult,
  EvaluationSource,
  RuleType,
  ExposureEvent,
  MetricEvent,
  TrackPayload,
  Logger,
  LogLevel,
  UnifiedStorageAdapter,
} from './types'

// Logging. Re-exported so configuring SDK logs is one import path.
export { createLogger, consoleLogger, consoleTransport, noopLogger } from '@avsbhq/core'
export { isDevEnvironment } from './logger'

// Identity helpers, for writing a `contextFrom` by hand.
export {
  DEFAULT_CONTEXT_KIND,
  VISITOR_COOKIE_NAME,
  VISITOR_HEADER_NAME,
  buildRequestContext,
  pageAttributes,
  parseCookieHeader,
  readSnippetVisitorId,
  readVisitorId,
  toFiniteNumber,
  visitorIdOf,
} from './requestContext'
export type { BuildContextInput, EdgeGeo } from './requestContext'

// Network error shapes, so an `onError` handler can branch on the cause
// instead of matching message strings.
export { AvsbEdgeNetworkError, AvsbEdgeTimeoutError } from './net'

// Evaluation primitives, for a caller who owns the request lifecycle and
// wants no client object at all.
export {
  DEFAULT_DATAFILE_TIMEOUT_MS,
  datafileRequestUrl,
  evaluateFlagEdge,
  fetchDatafileFromCdn,
  getAllFlagsEdge,
} from './core'
export type {
  DatafileFetchOutcome,
  EvaluateFlagEdgeOptions,
  FetchDatafileOptions,
} from './core'

// Wire builders and the batch cap, so the conformance harness can assert
// the exact body this package puts on the wire.
export {
  MAX_BATCH_ITEMS,
  buildExposureBatchBody,
  buildHeartbeatBody,
  buildMetricBatchBody,
  generateEventId,
} from './events'
export type {
  ExposureBatchBody,
  HeartbeatBody,
  MetricBatchBody,
  StampedExposureEvent,
  StampedMetricEvent,
} from './events'

export { SDK_TYPE, SDK_VERSION } from './version'
export { validateSdkKeyShape } from './sdkKeyShape'
export type { SdkKeyShapeResult } from './sdkKeyShape'
