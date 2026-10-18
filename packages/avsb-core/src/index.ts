// =====================================================================
// `@avsbhq/core` default entry — types + shared helpers consumed by
// every SDK package and per-language port.
//
// Engine primitives (`evaluateFlag`, `evaluateAudience`, `murmurhash3`,
// `bucketContext`) live on the `@avsbhq/core/engine` subpath. They are
// NOT re-exported here per spec §2.16 — surfacing them at the top of
// the API tree teaches consumers to bypass the tracker, lifecycle, and
// override system.
// =====================================================================

export type {
  // §2.1 EvalContext
  EvalContext,
  SingleContext,
  MultiContext,
  ContextMeta,
  LegacyEvalContext,
  // §2.2 Flag<T>
  Flag,
  // §2.3 InitResult
  InitResult,
  // §2.4 StickyAssignment
  StickyAssignment,
  StickyBucketService,
  // §2.5 DecisionLogEntry
  DecisionLogEntry,
  DecisionLog,
  // §2.6 TrackPayload
  TrackPayload,
  // §2.7 FlagDatafileRule + RuleType
  FlagDatafileRule,
  RuleType,
  // §2.8 FlagDatafileHoldout
  FlagDatafileHoldout,
  // §2.10 BanditConfig
  BanditConfig,
  BanditAction,
  FlagDatafileBandit,
  BanditDecisionLogEntry,
  // §2.12 EvaluationSource
  EvaluationSource,
  LegacyEvaluationSource,
  // §2.13 Logger
  Logger,
  LoggerOptions,
  LogTransport,
  LogLevel,
  // §2.14 ClientEventMap
  ClientEventMap,
  ClientEventName,
  // §2.15 FlagDatafile (v2)
  FlagDatafile,
  DatafileVersion,
  RegisteredAttribute,
  // Third-party forwarding destinations (analytics integrations §3.3, D-10)
  FlagDatafileIntegration,
  // Server-side datasets (e-commerce suite Phase 2)
  DatafileDataset,
  DatafileDatasetType,
  // Datafile sub-types
  FlagDatafileEntry,
  FlagDatafileVariation,
  FlagDatafileOverride,
  FlagDatafileAudience,
  // Audience
  ConditionGroup,
  Condition,
  // Commerce audience evaluation (e-commerce suite Phase 7)
  AudienceEvalOptions,
  PurchaseHistoryAttribute,
  // Events
  ExposureEvent,
  MetricEvent,
  // Legacy engine-internal
  FlagEvaluationDetails,
} from './types'

export { DecideOption, isConditionGroup } from './types'

// Context helpers
export {
  isMultiContext,
  getContextByKind,
  toLegacyEvalContext,
  userContext,
  bucketingKey,
  contextSummary,
  privateAttributesFrom,
} from './context'

// Flag<T> construction + legacy-source mapping
export {
  createFlag,
  notFoundFlag,
  notReadyFlag,
  mapLegacySource,
} from './flag'

// Logger
export {
  createLogger,
  noopLogger,
  consoleLogger,
  consoleTransport,
} from './logger'

// Event bus
export { createEventBus } from './eventBus'
export type { EventBus } from './eventBus'

// Typed-flag runtime check
export { checkExpectedType, findDatafileFlag } from './typedFlag'
export type { ExpectedFlagType } from './typedFlag'

// Datafile shape check, run once when a client adopts a datafile (N0-15):
// a malformed one is refused with a message naming the broken field.
export { datafileShapeProblem } from './datafileShape'
// Typed flag KEYS (SDK/API DX overhaul, Magic 2). `AvsbFlagKey` is `string`
// until `avsb codegen` writes the global `AvsbFlags` table, then it narrows to
// the project's real keys.
export type { AvsbFlagKey, AvsbFlagValue } from './flagKeys'
// The platform's flag key rule, and the one message every SDK logs (once per
// key) when a read misses (N1-9, N1-15).
export {
  FLAG_KEY_PATTERN,
  FLAG_KEY_MAX_LENGTH,
  isPlatformFlagKey,
  suggestFlagKey,
  flagNotFoundMessage,
} from './flagKeyRules'
export type { FlagLookupSource } from './flagKeyRules'


// Multi-context attribute resolution (exported for SDK conformance fixtures)
export { resolveDottedAttribute } from './evaluate'

// Holdouts (§8.2)
export { evaluateHoldout } from './holdouts'
export type { HoldoutEvaluation } from './holdouts'

// Bandits (§2.10 + §8.6 — epsilon-greedy / Thompson / UCB1)
export {
  evaluateBandit,
  createInMemoryBanditModelStore,
  seededGaussian,
} from './bandits'
export type {
  BanditModel,
  BanditModelStore,
  BanditPerActionStats,
} from './bandits'

// Data-plane endpoint contract (SDK/API DX overhaul §1.1). Single source of
// truth for every host and path; browser/node/edge/utils consume these instead
// of composing URLs themselves.
export {
  DEFAULT_CDN_HOST,
  DEFAULT_COLLECT_HOST,
  DEFAULT_APP_HOST,
  COLLECT_PATHS,
  STREAM_TICKET_PATH,
  HEARTBEAT_PATH,
  DATAFILE_FILENAME,
  PREVIEW_FILENAME,
  datafileUrl,
  previewUrl,
  datafileObjectKey,
  previewObjectKey,
  collectOriginFrom,
  collectUrl,
  resolveStreamEndpoint,
  streamTicketUrl,
  streamSubscribeUrl,
  streamEndpointUrl,
  heartbeatUrl,
  resolveHeartbeatEndpoint,
} from './endpoints'
export type {
  CollectPathKey,
  StreamEndpointInput,
  StreamEndpointResolution,
} from './endpoints'
