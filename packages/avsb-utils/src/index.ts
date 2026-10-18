// =====================================================================
// `@avsbhq/utils` default entry — every helper, plus the `createUtils`
// factory consumed by both Avsb* runtimes to populate `client.utils.*`.
//
// The package also exposes subpath exports for tree-shaking:
//   - `@avsbhq/utils/openfeature` — OpenFeature provider
//   - `@avsbhq/utils/log/{pino,winston,console}` — Logger transports
//   - `@avsbhq/utils/middleware/<framework>` — eight framework adapters
// =====================================================================

export { createRegistry } from './registry'
export type { CleanupRegistry } from './registry'

export { createGuarded } from './guardedPromise'
export type { GuardedThenable, GuardedController } from './guardedPromise'

export {
  once,
  debounce,
  throttle,
  retry,
  sleep,
  withTimeout,
  withDeadline,
} from './timing'
export type { CancelHandle, RetryOptions } from './timing'

export { FallbackChain, circuitBreaker } from './resilience'
export type {
  FallbackLayer,
  FallbackResult,
  CircuitBreakerOptions,
} from './resilience'

export {
  createLogger,
  consoleLogger,
  createConsoleTransport,
  noopLogger,
} from './log'
export type { Logger, LoggerOptions, LogTransport, LogLevel } from './log'

export {
  defineContextSchema,
  mergeContext,
  redactAttributes,
  anonymousId,
  isMultiContext,
  getContextByKind,
  userContext,
  bucketingKey,
  contextSummary,
} from './context'
export type {
  ContextSchema,
  ContextBuilder,
  DefinedContextSchema,
  SchemaError,
} from './context'

export { Browser, Device, Geolocation, PageView } from './visitorData'
export type {
  BrowserOpts,
  DeviceOpts,
  GeoOpts,
  PageOpts,
} from './visitorData'

export {
  snapshot,
  snapshotFresh,
  refreshAndSnapshot,
  serializeBootstrap,
  hydrateBootstrap,
  bootstrapFromUrl,
  bootstrapFromKV,
  bootstrapFromFile,
  getServerBootstrap,
} from './snapshots'
export type {
  FlagSnapshot,
  BootstrapBlob,
  BootstrapTarget,
  HydrateBootstrapResult,
  SnapshotClient,
  KVNamespace,
  BootstrapFromUrlOptions,
} from './snapshots'

// Read side of `applySnapshot`: serve server-evaluated values until a real
// datafile arrives, with honest provenance on every flag.
export { createSnapshotStore, snapshotReason } from './snapshotStore'
export type { SnapshotStore } from './snapshotStore'

export { createChanges } from './changes'
export type { ChangeClient, WaitForFlagOptions } from './changes'

export { createDecisionRecorder } from './decisions'
export type {
  DecisionSink,
  DecisionRecorder,
  DecisionRecorderOptions,
} from './decisions'

export { createOtelSink } from './decisions/otel'
export { createSentrySink } from './decisions/sentry'
export { createDatadogSink } from './decisions/datadog'
export {
  createSnowflakeSink,
  SNOWFLAKE_CREATE_TABLE,
} from './decisions/snowflake'
export { createBigQuerySink } from './decisions/bigquery'
export { createRedshiftSink } from './decisions/redshift'
export { createClickHouseSink } from './decisions/clickhouse'

export {
  createMemoryAdapter,
  createRedisAdapter,
  createCookieAdapter,
  createLocalStorageAdapter,
  createIndexedDBAdapter,
  createDynamoDBAdapter,
  createPostgresAdapter,
  createDurableObjectAdapter,
} from './storage'
export type {
  UnifiedStorageAdapter,
  CookieJar,
  CookieOpts,
  RedisLike,
  DynamoDBClientLike,
  PgClientLike,
  DurableObjectStubLike,
} from './storage'

// The Redis and DynamoDB BIG-SEGMENT stores were deleted here (breaking
// change B28). Nothing evaluated big segments in any SDK: no datafile field
// carried membership, no audience condition branched on it, and no client
// ever held a store, so both modules were orphans that made a docs page
// describe a feature that could not run. Sticky-bucket stores below are
// unaffected and are wired end to end.

export {
  createDynamoDBStickyBucketService,
} from './storage/dynamodbStickyBucket'
export type {
  DynamoDBStickyLike,
  DynamoDBStickyBucketOptions,
} from './storage/dynamodbStickyBucket'

export {
  createPostgresStickyBucketService,
} from './storage/postgresStickyBucket'
export type {
  PostgresLike,
  PostgresStickyBucketOptions,
} from './storage/postgresStickyBucket'

export {
  createDurableObjectStickyBucketService,
} from './storage/durableObjectStickyBucket'
export type {
  DurableObjectLike,
  DurableObjectStickyBucketOptions,
} from './storage/durableObjectStickyBucket'

export { createTrack, Transaction, itemOf } from './track'
export type { TrackClient, Item, TransactionInit } from './track'

export {
  requestContextStorage,
  getRequestClient,
  getRequestContext,
  getRequestDecisionLog,
} from './request'
export type { RequestBoundClient, RequestScope } from './request'

export { createUtils } from './createUtils'
export type { CreateUtilsClient, CreateUtilsOptions } from './createUtils'

export type { AvsbUtils } from './types'
// Core types these signatures reference. Re-exported so a consumer can NAME what
// this package hands back (`Flag`, its `source`/`ruleType` members, the context
// it takes) from the same import path, instead of being told to install
// @avsbhq/core to write a variable annotation.
export type {
  Flag,
  RuleType,
  EvaluationSource,
  EvalContext,
  SingleContext,
  MultiContext,
  TrackPayload,
  DecisionLog,
  FlagDatafile,
} from '@avsbhq/core'
