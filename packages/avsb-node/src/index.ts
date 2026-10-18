// Main class
export { AvsbServer } from './AvsbServer'

// Per-request client
export type { UserBoundClient } from './UserBoundClient'

// ---------------------------------------------------------------------------
// Framework middleware — ONE home (breaking change B6).
//
// These are the implementations from `@avsbhq/utils/middleware/*`, re-exported
// so a project that only installs @avsbhq/node still gets Express and Fastify
// support. This package used to ship its OWN `expressMiddleware(client,
// {userIdFrom})` next to the utils `expressMiddleware(server, {contextFrom})`:
// same name, incompatible options, and the node README documented the node
// export with the utils options, so the flagship integration example threw
// "config.userIdFrom is not a function" on the first request.
//
// One name, one signature: `contextFrom(req)` returns the EvalContext (return
// undefined to skip AvsB for that request), and the middleware opens an
// AsyncLocalStorage scope so `getRequestClient()` works in nested code.
//
// Hono, Koa, Next, Lambda, and Workers adapters live in
// `@avsbhq/utils/middleware/*` and are not mirrored here: re-exporting eight
// framework adapters from a server SDK is how the two-homes problem started.
// ---------------------------------------------------------------------------
export { expressMiddleware } from '@avsbhq/utils/middleware/express'
export type {
  ExpressAvsbServer,
  ExpressMiddlewareOptions,
} from '@avsbhq/utils/middleware/express'
export { fastifyPlugin } from '@avsbhq/utils/middleware/fastify'
export type {
  FastifyAvsbServer,
  FastifyPluginOptions,
} from '@avsbhq/utils/middleware/fastify'

// Sticky bucketing
export { InMemoryStickyBucketService, RedisStickyBucketService } from './stickyBucket'
export type { RedisLike, RedisStickyBucketOptions } from './stickyBucket'

// Streaming (implementation shared with the browser via @avsbhq/utils)
export { createStreamingClient } from './streaming'
export type { StreamingClient, StreamingOptions } from './streaming'

// Decision log
export { createDecisionLog } from './decisionLog'

// Webhook signature verification. AvsB signs every delivery over
// `id + "." + timestamp + "." + body` (Standard Webhooks scheme); this verifies it
// against the RAW body bytes and enforces a 5-minute replay window by default.
export { verifyWebhookSignature, DEFAULT_TOLERANCE_SECONDS } from './webhookSignature'
export type {
  WebhookHeaders,
  VerifyWebhookOptions,
  WebhookVerifyResult,
  WebhookVerifyFailure,
} from './webhookSignature'

// Logger. `resolveServerLogger` and `isDevEnvironment` are exported so a host
// application can mirror the SDK's own dev/production decision.
export {
  noopLogger,
  createLogger,
  consoleLogger,
  consoleTransport,
  defaultLogger,
  isDevEnvironment,
  resolveServerLogger,
} from './logger'
export type { ServerLogLevel } from './logger'

// `client.utils.*` binding shape, for consumers declaring their own variables.
export type { AvsbUtils } from '@avsbhq/utils'

// Version
export { SDK_VERSION } from './version'

// Types — server-specific
export type {
  AvsbServerOptions,
  EventOptions,
  ServerGetFlagOptions,
  GetAllFlagsOptions,
  ServerEventMap,
  ServerEventName,
} from './types'

// Types — re-exported from @avsbhq/core for consumer convenience
export type {
  EvalContext,
  SingleContext,
  MultiContext,
  Flag,
  InitResult,
  StickyAssignment,
  StickyBucketService,
  DecisionLog,
  DecisionLogEntry,
  TrackPayload,
  RuleType,
  EvaluationSource,
  Logger,
  FlagDatafile,
  FlagEvaluationDetails,
  ExposureEvent,
  MetricEvent,
} from '@avsbhq/core'
export { DecideOption } from '@avsbhq/core'

// Purchase tracking
export type { PurchaseOrder } from './serverTracker'

// Server-side datasets — runtime surface is `client.datasets.get(slug, key)`
// on the AvsbServer instance; these are the types for consumers' own
// declarations.
export type { DatasetsClient, DatasetGetResult } from './datasets'
export type { DatafileDataset, DatafileDatasetType } from '@avsbhq/core'

// Server-side recommendations — runtime surface is
// `client.recs.get({ recipe, … })` / `client.recs.trackClick(…)` on the
// AvsbServer instance; these are the types for consumers' own declarations.
export type {
  RecsClient,
  RecsGetRequest,
  RecsResult,
  RecProduct,
  RecsAttribution,
  DatafileRecipe,
} from './recs'

// Commerce audiences — shape of the `purchaseHistory` targeting attribute
// consumed by PURCHASE_HISTORY audience conditions. See README §4 for the full
// commerce attribute surface (`cartValue`, `viewedSkus`, `viewedCategories`).
export type { PurchaseHistoryAttribute } from '@avsbhq/core'
