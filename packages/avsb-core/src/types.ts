// =====================================================================
// Shared wire-protocol types for the A vs B SDK family.
//
// Every package (browser, node, react, next, edge, react-native, test,
// utils, vue, svelte, solid, angular) — and every per-language SDK port
// — implements the shapes declared here. Spec §2 of
// _specs/sdk-launch-readiness-spec.md is the source of truth for these
// names and shapes.
// =====================================================================

// ---------------------------------------------------------------------
// §2.1 EvalContext — multi-context kinded identity.
// ---------------------------------------------------------------------

export interface ContextMeta {
  /** Attribute keys redacted from exposure events and decision-log reasons. */
  privateAttributes?: string[]
  /** Mark this context as anonymous (suppresses some integrations). */
  anonymous?: boolean
}

export interface SingleContext {
  /** Context kind. 'user' is conventional but not enforced. */
  kind: string
  /** Unique key within the kind (bucketing identifier for this kind). */
  key: string
  /** Optional human-readable name (UI display only, not used in eval). */
  name?: string
  /** Reserved metadata. */
  _meta?: ContextMeta
  /** Targeting attributes. Reserved keys: 'kind', 'key', 'name', '_meta'. */
  [attribute: string]: unknown
}

export interface MultiContext {
  kind: 'multi'
  /** Keyed by context kind. At least one entry required (other than 'kind'). */
  [contextKind: string]: SingleContext | 'multi'
}

export type EvalContext = SingleContext | MultiContext

/**
 * Internal legacy context shape: the existing single-bag evaluator in
 * `evaluate.ts` accepts this. New SDK surfaces accept `EvalContext`
 * (above) and adapt to this shape before invoking the evaluator.
 *
 * Workstream 5 (CoW 6) rewrites the evaluator to consume `EvalContext`
 * natively, at which point `LegacyEvalContext` is removed.
 */
export interface LegacyEvalContext {
  attributes: Record<string, unknown>
}

// ---------------------------------------------------------------------
// §2.2 Flag<T> — unified evaluation return.
// ---------------------------------------------------------------------

export interface Flag<T = unknown> {
  /** The variation value typed against the default. */
  readonly value: T
  /** Variation key (null if served the default or not found). */
  readonly variationKey: string | null
  /** Why this value was produced. */
  readonly source: EvaluationSource
  /** Rule that matched (null when source is 'default'/'not_found'/etc). */
  readonly ruleId: string | null
  /** Rule type that matched (null when no rule applied). */
  readonly ruleType: RuleType | null
  /** Structured reasons for this decision. */
  readonly reasons: string[]
  /** ms-epoch when evaluated. */
  readonly evaluatedAt: number
  /** µs elapsed in the evaluator. */
  readonly durationMicros: number
  /**
   * Convenience predicate, locked identically in every SDK (SDK/API DX
   * overhaul spec §1.4): true only when the value came from a real
   * decision (`rule`, `holdout`, `bandit`, `runtimeOverride`,
   * `datafileOverride`, `sticky`) AND is truthy. Always false for
   * `default`, `not_found`, `disabled`, and `not_ready`.
   */
  isEnabled(): boolean
  /**
   * Convenience: "is this flag key present in the datafile". False for
   * `not_found` and for `not_ready`, because with no datafile loaded the
   * question is not yet answerable.
   */
  exists(): boolean
}

// ---------------------------------------------------------------------
// §2.3 InitResult.
// ---------------------------------------------------------------------

export interface InitResult {
  success: boolean
  /** 'cache' deliberately removed; never returned by current code. */
  source: 'network' | 'bootstrap' | 'timeout' | 'error'
  error?: Error
  /**
   * Serving STALE-BUT-REAL flag values: a bootstrap or a cached datafile is
   * loaded and readable, and a refresh of it failed. `success` is `true`
   * because flags are answerable; polling continues in the background.
   *
   * It is never set when there is nothing to serve. A failed fetch with no
   * bootstrap and no cache resolves `{success: false, source: 'error'}` (spec
   * §1.2, breaking change B1); reading "degraded" as "the SDK is fine on
   * defaults" was the bug that let a typo'd SDK key look healthy.
   */
  degraded?: boolean
}

// ---------------------------------------------------------------------
// §2.4 StickyAssignment + StickyBucketService.
// ---------------------------------------------------------------------

export interface StickyAssignment {
  variationId: string
  ruleId: string
  ruleType: RuleType
  /** ms-epoch when assigned. */
  assignedAt: number
}

export interface StickyBucketService {
  /** Synchronous lookup, hot-path safe. */
  lookup(userId: string, flagKey: string): StickyAssignment | null
  /** Persist an assignment. Fire-and-forget. */
  save(userId: string, flagKey: string, assignment: StickyAssignment): void
}

// ---------------------------------------------------------------------
// §2.5 DecisionLogEntry (with redaction support).
// ---------------------------------------------------------------------

export interface DecisionLogEntry {
  flagKey: string
  /** Redacted to '[REDACTED]' if any private attribute appeared in the value. */
  value: unknown
  variationKey: string | null
  source: EvaluationSource
  ruleId: string | null
  ruleType: RuleType | null
  /** Reason strings have private attribute values replaced with '[REDACTED]'. */
  reasons: string[]
  evaluatedAt: number
  /** µs elapsed in the evaluator. */
  durationMicros: number
  /** Context kind+key summary; attributes never logged. */
  contextSummary: Array<{ kind: string; key: string }>
  /** Set by manualExposure to distinguish from auto-fired entries. */
  manuallyFired?: boolean
}

export interface DecisionLog {
  readonly entries: DecisionLogEntry[]
}

// ---------------------------------------------------------------------
// §2.6 TrackPayload — unified.
// ---------------------------------------------------------------------

export interface TrackPayload {
  /**
   * Numeric metric value, for average-value metrics: items in a cart, seats on
   * a plan, seconds watched. Lands in the wire and storage column `value`.
   *
   * This is NOT the money field. The two are separate columns end to end
   * (`metric_events.revenue` and `metric_events.value` in storage, both
   * declared by the `metric_batch` wire fixture), so one conversion can carry
   * money, a quantity, or both, and a revenue metric never has to guess which
   * of the two it was handed.
   */
  value?: number
  /**
   * Money for this conversion, in decimal MAJOR units of the project currency
   * (49.99, not 4999). Lands in the wire and storage column `revenue`.
   *
   * Omit it for a non-revenue conversion; it is sent as null.
   */
  revenue?: number
  /**
   * Free-form properties.
   *
   * Carried end to end on EXPOSURE events only. Metric (conversion) events
   * are not stored with properties: the ingestion contract for
   * `/v1/collect/metric-batch` is `{eventId, visitorId, eventName, revenue,
   * value?, timestamp, pageUrl}`, and anything else on the object is dropped
   * at the edge. The server SDK warns once and drops them rather than
   * pretending, so segmenting on a track property is not available yet.
   */
  properties?: Record<string, unknown>
  /** Override the context to track against (server SDK only). */
  context?: EvalContext
}

// ---------------------------------------------------------------------
// §2.7 FlagDatafileRule + §2.8 FlagDatafileHoldout + §2.10 BanditConfig.
// ---------------------------------------------------------------------

export type RuleType = 'targeted_delivery' | 'ab_test' | 'holdout' | 'bandit'

export interface FlagDatafileRule {
  id: string
  type: RuleType
  enabled: boolean
  audienceIds: string[]
  /** Dotted path: 'user.key' or 'organization.key' for multi-context bucketing. */
  hashAttribute: string
  /** Holdout reference: rules inside a holdout are skipped for held-out users. */
  holdoutId?: string
  trafficAllocation: number | null
  variations: Array<{ variationId: string; percentage: number }>
  /**
   * Inline bandit config (only meaningful when `type === 'bandit'`). When
   * present the bandit is addressed by this rule's `id`, so its model is
   * private to the rule.
   */
  bandit?: BanditConfig
  /**
   * Shared bandit reference: joins this rule to an entry in
   * `FlagDatafile.bandits` by `FlagDatafileBandit.id`. The referenced
   * entry's `key` is the bandit key the model store is addressed by, so
   * several rules (across several flags) can share one model. Mirrors the
   * `holdoutId` pattern above. Takes precedence over `bandit` when both
   * are present.
   */
  banditId?: string
}

export interface FlagDatafileHoldout {
  id: string
  key: string
  /** 0..1, the fraction of traffic held out across participating flags. */
  trafficAllocation: number
  /** Flags participating in this holdout. */
  flagIds: string[]
  /** Hash attribute used to consistently bucket held-out users across flags. */
  hashAttribute: string
  /** Variation served to held-out users per flag (typically the control). */
  defaultVariationByFlag: Record<string, string>
}

// ---------------------------------------------------------------------
// §2.9 was BigSegmentStore. Deleted in the SDK/API DX overhaul (breaking
// change B28, spec §6 exclusion 5).
//
// Nothing evaluated big segments: not the reference evaluator, not one of
// the eight ports. The datafile never carried membership, the audience
// evaluator had no `bigSegment` condition branch, and no client ever held
// a store. What existed was an interface, two orphan store implementations
// in @avsbhq/utils, and a docs page describing a feature that could not
// run. Shipping the real thing needs platform design (datafile shape,
// membership sync, evaluator branch) and is its own future plan.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// §2.10 BanditConfig.
// ---------------------------------------------------------------------

export interface BanditConfig {
  algorithm: 'epsilon-greedy' | 'thompson-sampling' | 'ucb1'
  /** Exploration rate (0..1) for epsilon-greedy. */
  explorationRate?: number
  /** Reward metric key (analytics) used for optimisation. */
  rewardMetric: string
  actions: BanditAction[]
}

export interface BanditAction {
  id: string
  variationId: string
  /** Numeric/categorical context attributes, declared at platform level. */
  contextAttributes?: Record<string, number | string>
}

export interface FlagDatafileBandit {
  id: string
  key: string
  config: BanditConfig
}

export interface BanditDecisionLogEntry extends DecisionLogEntry {
  banditKey: string
  actionId: string
  modelVersion: string
  actionProbability: number
  /** epsilon used at decision time, or null when not applicable. */
  optimalityGap: number | null
}

// ---------------------------------------------------------------------
// §2.11 DecideOption.
// ---------------------------------------------------------------------

/**
 * Per-call evaluation options, shared vocabulary across every SDK.
 *
 * TWO members, and both are honoured (breaking change B4 deleted
 * `EXCLUDE_VARIABLES`, `IGNORE_STICKY_BUCKET`, and `ENABLED_FLAGS_ONLY`,
 * which no evaluator in any language ever read).
 *
 * - `DISABLE_EXPOSURE`: evaluate without recording an exposure. Use it for
 *   admin panels, previews, and bulk reads that must not enter experiment
 *   results.
 * - `INCLUDE_REASONS`: ask for the reason strings on the returned flag. The
 *   JS SDKs collect reasons unconditionally (allocating a small array of
 *   strings is cheaper than the debugging time it saves), so passing this in
 *   JS changes nothing and `flag.reasons` is always populated. It is real in
 *   the SDKs where reason collection costs allocation per evaluation (Go,
 *   Java, .NET) and gate collection behind it, so one vocabulary spans the
 *   family.
 */
export const DecideOption = {
  DISABLE_EXPOSURE: 'DISABLE_EXPOSURE',
  INCLUDE_REASONS: 'INCLUDE_REASONS',
} as const
export type DecideOption = (typeof DecideOption)[keyof typeof DecideOption]

// ---------------------------------------------------------------------
// §2.12 EvaluationSource.
// ---------------------------------------------------------------------

export type EvaluationSource =
  | 'datafileOverride'
  | 'runtimeOverride'
  | 'sticky'
  | 'rule'
  | 'holdout'
  | 'bandit'
  | 'default'
  | 'not_found'
  | 'disabled'
  /**
   * The SDK had no datafile at evaluation time (init never completed, or
   * it failed and there was no bootstrap). Distinct from `not_found`,
   * which means "the datafile loaded and this key is not in it"
   * (SDK/API DX overhaul spec §1.2). Never produced by the evaluator
   * itself: it is a client-layer state.
   */
  | 'not_ready'

/**
 * Source values the in-tree evaluator emits. Narrower and older than the
 * public `EvaluationSource`: it still says `override` / `runtime_override`
 * where the public surface says `datafileOverride` / `runtimeOverride`.
 * `mapLegacySource` is the only sanctioned bridge between the two, and
 * `not_ready` deliberately has no legacy member.
 */
export type LegacyEvaluationSource =
  | 'override'
  | 'rule'
  | 'default'
  | 'not_found'
  | 'disabled'
  | 'runtime_override'
  | 'sticky'
  | 'holdout'
  | 'bandit'

// ---------------------------------------------------------------------
// §2.13 Logger — shared, multi-transport.
// ---------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogTransport {
  level: LogLevel
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void
}

export interface LoggerOptions {
  /** Global threshold; transports may filter higher. */
  level?: LogLevel
  prefix?: string
  transports: LogTransport[]
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
  /** Scoped sub-logger that inherits transports + threshold. */
  child(prefix: string): Logger
}

// ---------------------------------------------------------------------
// §2.14 ClientEventMap — shared event surface.
// ---------------------------------------------------------------------

export interface ClientEventMap {
  ready: (result: InitResult) => void
  error: (error: Error) => void
  configUpdate: (data: {
    publishedAt: string
    reason: 'poll' | 'stream' | 'manual'
  }) => void
  flagChange: (data: {
    flagKey: string
    previousValue: unknown
    newValue: unknown
  }) => void
  evaluation: (data: {
    flagKey: string
    flag: Flag
    contextKeys: string[]
  }) => void
  exposure: (event: ExposureEvent) => void
  /** Sticky assignment references a rule that no longer matches the datafile. */
  stickyOrphan: (data: {
    flagKey: string
    userId: string
    assignment: StickyAssignment
  }) => void
}
export type ClientEventName = keyof ClientEventMap

// ---------------------------------------------------------------------
// §2.15 FlagDatafile (v2).
// ---------------------------------------------------------------------

/**
 * Datafile schema version is bumped to 2 in this rollout. The wire shape
 * adds optional holdouts/bandits/contextKinds/exposureSampling fields that
 * the evaluator will consume once Workstream 5 (CoW 6) lands.
 *
 * SDKs accept version 1 and 2 during the in-flight migration window and
 * surface a clear error on any version > 2 or < 1. The pre-launch
 * guarantee (no external datafiles in the wild) means no compatibility
 * shims are required.
 */
export type DatafileVersion = 1 | 2

export interface RegisteredAttribute {
  key: string
  type: 'string' | 'number' | 'boolean' | 'json'
  contextKind?: string
}

// ---------------------------------------------------------------------
// Server-side datasets (e-commerce suite Phase 2).
// ---------------------------------------------------------------------

/**
 * Dataset kinds served from the edge KV store:
 * - `LIST`: membership lookup; a hit returns `true`.
 * - `TABLE`: keyed single-row lookup; a hit returns the parsed row.
 * - `FEED`: keyed ordered-items lookup (e.g. recommendation slates).
 */
export type DatafileDatasetType = 'LIST' | 'TABLE' | 'FEED'

/**
 * Dataset descriptor carried in the datafile. `liveVersion` is the
 * short id of the currently-active `DatasetVersion`; SDK reads resolve
 * keys against exactly this version (single-KV-read serving, no
 * pointer chase at the edge).
 */
export interface DatafileDataset {
  slug: string
  type: DatafileDatasetType
  liveVersion: number
}

export interface FlagDatafile {
  version: DatafileVersion
  projectType: 'FEATURE_FLAG'
  sdkKey: string
  environmentKey: string
  publishedAt: string
  collectEndpoint: string
  heartbeatEndpoint?: string
  /**
   * SSE stream TICKET endpoint, server controlled (SDK/API DX overhaul §1.1).
   * Same pattern as `collectEndpoint` and `heartbeatEndpoint`: the publisher
   * decides where SDKs stream from, so a self-hosted or proxied deployment
   * never has to be configured client-side.
   *
   * Optional because datafiles published before the field existed simply omit
   * it. When it is absent AND no explicit option was passed, an SDK leaves
   * streaming off and says so; it must never fall back to a guessed host
   * (see `resolveStreamEndpoint` in ./endpoints).
   */
  streamEndpoint?: string
  flags: FlagDatafileEntry[]
  audiences: FlagDatafileAudience[]
  /** Added in v2. */
  holdouts?: FlagDatafileHoldout[]
  /** Added in v2. */
  bandits?: FlagDatafileBandit[]
  /**
   * Pre-launch carried `registeredAttributes?: string[]`. v2 expands this
   * to a typed registration; the string[] form is accepted on load and
   * normalised by the SDK during the migration window.
   */
  registeredAttributes?: RegisteredAttribute[] | string[]
  /** Added in v2: declared context kinds. */
  contextKinds?: string[]
  /** Added in v2: 0..1 default exposure sampling rate. */
  exposureSampling?: number
  /**
   * Server-side datasets (e-commerce suite Phase 2). Optional and
   * additive: datafiles published before datasets existed simply omit
   * the field and dataset reads resolve to `{ found: false }`.
   */
  datasets?: DatafileDataset[]
  /**
   * ISO-4217 exponent of the project currency (e-commerce suite Phase 7,
   * additive, C5). Converts minor-unit money values on commerce audience
   * conditions (CART_VALUE, PURCHASE_HISTORY) to decimal major units at
   * eval time. SDKs default to `2` when the field is absent (older cached
   * datafiles).
   */
  currencyExponent?: number
  /**
   * Third-party forwarding destinations (analytics integrations spec §3.3,
   * flag datafile v2 / D-10). Optional and additive: ABSENT OR EMPTY MEANS
   * FORWARD NOTHING, so a datafile published before the block existed (or one
   * stripped by the `integrations_forwarding` entitlement) leaves every
   * dispatcher off. Only destinations the customer enabled are ever emitted.
   */
  integrations?: FlagDatafileIntegration[]
}

/**
 * One forwarding destination as the datafile ships it. Identical shape on the
 * flag and experiment wires — one server-side builder feeds both.
 *
 * `provider` is the LOWERCASED provider id (`google_tag_manager`); dispatchers
 * gate on these exact strings. `names` carries ONLY the event names the
 * customer overrode, so an untouched destination costs `{}` on the wire and
 * the SDK's own defaults apply. `forward` (non-exposure event families) and
 * `category` (consent category) are declared for wire completeness; the flag
 * SDKs emit exposures only and ignore both today.
 *
 * Every optional field is genuinely optional on the wire: a hand-written or
 * older datafile row is read fail-closed rather than trusted.
 */
export interface FlagDatafileIntegration {
  provider: string
  forward?: { goals: boolean; purchases: boolean; recs: boolean }
  names?: Record<string, string>
  /** GA4 measurement id for `send_to` routing. Google Analytics rows only. */
  sendTo?: string
  /** dataLayer `event` key. Google Tag Manager rows only. */
  eventName?: string
  category?: string
}

// ---------------------------------------------------------------------
// Datafile sub-types (unchanged shape, types-only export).
// ---------------------------------------------------------------------

export interface FlagDatafileEntry {
  id: string
  key: string
  type: 'boolean' | 'string' | 'number' | 'json'
  enabled: boolean
  defaultVariationId: string
  variations: FlagDatafileVariation[]
  overrides: FlagDatafileOverride[]
  rules: FlagDatafileRule[]
}

export interface FlagDatafileVariation {
  id: string
  key: string
  value: unknown
}

export interface FlagDatafileOverride {
  userId: string
  variationId: string
}

export interface FlagDatafileAudience {
  id: string
  rules: ConditionGroup
}

// ---------------------------------------------------------------------
// Audience condition types.
// ---------------------------------------------------------------------

export interface ConditionGroup {
  id: string
  logic: 'AND' | 'OR'
  conditions: (Condition | ConditionGroup)[]
}

export interface Condition {
  id: string
  type: string
  attribute?: string
  operator: string
  value: string | string[]
  /**
   * Multi-context kinded identity (§8.1). When present, the audience
   * evaluator resolves `attribute` from the matching sub-context. When
   * absent, the evaluator falls back to legacy single-context lookup so
   * v1 datafiles keep working during the migration window.
   */
  contextKind?: string
}

export function isConditionGroup(
  item: Condition | ConditionGroup
): item is ConditionGroup {
  return 'logic' in item && 'conditions' in item
}

// ---------------------------------------------------------------------
// Commerce audience evaluation (e-commerce suite Phase 7, C10).
// ---------------------------------------------------------------------

/**
 * Options threaded through the audience evaluator. `currencyExponent`
 * comes from the FF datafile (`FlagDatafile.currencyExponent`, C5) and
 * converts minor-unit condition values on CART_VALUE /
 * PURCHASE_HISTORY conditions to decimal major units for comparison
 * against caller-supplied attributes. Defaults to `2` when absent.
 */
export interface AudienceEvalOptions {
  currencyExponent?: number
}

/**
 * Shape of the `purchaseHistory` targeting attribute consumed by
 * PURCHASE_HISTORY audience conditions in the server SDKs (C10).
 *
 * - `lastPurchaseAt` is epoch **milliseconds**.
 * - `lifetimeSpend` is decimal **major** units of the project currency
 *   (no minor units in the developer-facing attribute surface).
 *
 * A completely absent `purchaseHistory` attribute makes ALL
 * PURCHASE_HISTORY operators evaluate false, including
 * `has_not_purchased`. Server callers own their data; absence means
 * "not provided", not "never purchased" (this deliberately diverges
 * from the browser snippet, where a KV profile miss is authoritative).
 */
export interface PurchaseHistoryAttribute {
  hasPurchased: boolean
  lastPurchaseAt?: number
  lifetimeSpend?: number
  orderCount?: number
}

// ---------------------------------------------------------------------
// Event types — shared across runtime trackers.
// ---------------------------------------------------------------------

export interface ExposureEvent {
  /**
   * Stable UUID v4 for deduplication. Assigned at enqueue time by the tracker
   * so retries carry the same id. Optional on construction: trackers stamp it
   * if absent; the field is present on every event that reaches the wire.
   */
  eventId?: string
  visitorId: string
  experimentId: string
  variationId: string
  eventName: string
  revenue: number | null
  timestamp: number
  pageUrl: string
  /** Decision metadata: flagKey, flagId, holdoutId, banditKey, and friends. */
  properties?: Record<string, unknown>
  /**
   * The CONTEXT's registered attributes, stringified for storage. This is the
   * field that can carry personal data, so it is the one an SDK redacts
   * against `_meta.privateAttributes` before the event leaves the process.
   */
  attributes?: Record<string, string>
}

/**
 * Metric (conversion) event as `/v1/collect/metric-batch` accepts it.
 *
 * There is deliberately no `properties` field: the ingestion schema for this
 * path does not declare one, so anything extra was stripped at the edge and
 * never reached storage. The field used to be declared here, which made
 * `track(key, { properties })` look like it was recorded when it was not
 * (breaking type change, SDK/API DX overhaul). Exposure events DO carry
 * properties, see `ExposureEvent` above.
 */
export interface MetricEvent {
  /**
   * Stable UUID v4 for deduplication. Assigned at enqueue time by the tracker
   * so retries carry the same id. Optional on construction: trackers stamp it
   * if absent; the field is present on every event that reaches the wire.
   */
  eventId?: string
  visitorId: string
  eventName: string
  /** Money in decimal MAJOR units, or null for a non-revenue conversion. */
  revenue: number | null
  /**
   * Numeric metric value for average-value metrics, or null for a count.
   *
   * A SECOND column, not an alias of `revenue`: storage declares both
   * (`metric_events.revenue` and `metric_events.value`, Nullable(Float64)
   * each) and the ingestion route persists both. Optional on the wire so a
   * client predating the field still validates.
   */
  value?: number | null
  timestamp: number
  pageUrl: string
}

// ---------------------------------------------------------------------
// Legacy / engine-internal evaluation details.
//
// Used by the existing evaluator in `evaluate.ts`. The public SDK
// surface returns `Flag<T>` (above); this stays for engine code that
// CoW 6 will rewrite.
// ---------------------------------------------------------------------

export interface FlagEvaluationDetails {
  value: unknown
  variationKey: string | null
  /**
   * Legacy single-flag source enum used by the in-tree evaluator. The
   * SDK surface maps these onto the §2.12 `EvaluationSource` shape when
   * producing a public `Flag<T>` value.
   */
  source: LegacyEvaluationSource
  ruleId: string | null
  ruleType: RuleType | null
  flagKey: string
  reasons: string[]
}

// ---------------------------------------------------------------------
// §2.16 — items that downstream packages must NOT import directly.
//
// `evaluateFlag`, `evaluateAudience`, `murmurhash3`, `bucketContext`
// live on the `@avsbhq/core/engine` subpath. They are NOT re-exported
// from the default entry of `@avsbhq/browser` or `@avsbhq/node`.
// ---------------------------------------------------------------------
