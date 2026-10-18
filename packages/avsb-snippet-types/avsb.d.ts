// TypeScript declarations for `window.avsb`, the A vs B web-snippet API.
//
// SOURCE OF TRUTH for two consumers: this package (`@avsbhq/snippet-types`), and
// the dashboard code editor's ambient lib at `snippet/types/avsb.d.ts`, which is
// a generated copy (run `npm run sync:types` here after editing; `sync.test.ts`
// fails if it drifts).
//
// Every shape mirrors the runtime's own types in `snippet/src/types.ts` (plus
// `utils/types.ts`, `purchase.ts`, `datasets.ts`, `recs.ts`, `commerceTypes.ts`),
// and `sync.test.ts` asserts that `AvsbApi` and `AvsbTrackFunction` carry exactly
// the members of `AvsbPublicAPI` and `TrackFunction` there, so an API added to the
// snippet cannot quietly go missing here.
//
// Two rules for editing:
//
//  - Keep every interface member on ONE line. The sync test reads members by line.
//  - Never add an `import` or `export`. That turns the file into a module, which
//    hides every name below and stops `interface Window` merging with the
//    browser's own, so consumers following the documented setup get nothing.
//    Names are FROZEN at launch: rename nothing, add only.

// --- Tracking ---

interface AvsbTrackEventProperties {
  /** Monetary amount for this event. Feeds revenue metrics. Plain number, no currency symbol. */
  revenue?: number
  /** Continuous measurement (order value, load time, scroll depth) for percentile and value metrics. */
  value?: number
}

interface AvsbPurchaseItem {
  sku: string
  /** Parent product id when `sku` is a variant. Defaults to `sku` server-side. */
  productKey?: string
  name?: string
  price?: number
  quantity?: number
  category?: string
}

/** An order passed to `avsb.track.purchase`. Money is decimal, in the project currency. */
interface AvsbPurchaseOrder {
  /** Unique order id. Required. */
  orderId: string
  /** Order total as a decimal, e.g. 99.95. Required. */
  total: number
  /** ISO 4217 code. Defaults to the project currency. */
  currency?: string
  subtotal?: number
  shipping?: number
  tax?: number
  discount?: number
  coupon?: string
  /** Stored but excluded from every calculation. For testing your integration. */
  test?: boolean
  items?: AvsbPurchaseItem[]
}

interface AvsbTrackFunction {
  /** Fire a custom event by its metric event key. Numbers are coerced to strings, so a numeric key works when the metric's key is those digits. An unmatched key warns and lists the keys that do work. */
  event(eventKey: string | number, properties?: AvsbTrackEventProperties): void
  /** Record a visitor attribute you can slice results by. */
  segment(segmentKey: string, segmentValue: string): void
  /** Send an order immediately. Not batched. */
  purchase(order: AvsbPurchaseOrder): void
  /** Tell the snippet the current cart total, for commerce audience conditions. `totalMinor` wins when both are set. */
  cart(cart: { total?: number; totalMinor?: number }): void
}

// --- Event bus record ---

type AvsbIntegrationEventType =
  | 'exposure'
  | 'goal'
  | 'purchase'
  | 'rec_impression'
  | 'rec_click'
  | 'custom'
  | 'test'

/**
 * The record delivered to `avsb.on('event')` subscribers, one per dispatched
 * exposure, goal, purchase, or rec event. snake_case, shaped for analytics tools.
 */
interface AvsbIntegrationRecord {
  /** Experiment shortId as a string. */
  experiment_id: string
  /** Display name; falls back to the shortId, never an empty string. */
  experiment_name: string
  /** Variation shortId as a string. */
  variation_id: string
  /** Display name; falls back to the shortId, never an empty string. */
  variation_name: string
  event_type: AvsbIntegrationEventType
  /** Rendered event name (native defaults plus your configured overrides). */
  event_name: string
  /** UUID; matches the AvsB event id for tracker-queued events. */
  event_id: string
  revenue: number | null
  value: number | null
  /** Purchases only. */
  currency?: string
  /** Purchases only: the order id. */
  transaction_id?: string
  /** Goals and custom events: metric `type:shortId` or the developer eventKey. */
  goal_key?: string
  visitor_id: string
  page_url: string
  timestamp: number
  sdk_version: string
  /** Recommendation product data (recipe, items, position, ...). */
  attributes?: Record<string, string | number>
  /** Set to 'preview' or 'internal' on QA traffic; absent for live visitors. */
  source?: 'preview' | 'internal'
}

// --- Waiting ---

// A wait target: a CSS selector, a `window.x.y` global path, or a predicate.
type AvsbWaitTarget<T = unknown> = string | (() => T)

interface AvsbWaitOptions {
  /** Milliseconds before the wait rejects. Default 10000. */
  timeout?: number
  /** Resolve a selector with an array of all matches (querySelectorAll). */
  all?: boolean
}

// Promise-like whose `.catch()` is OPTIONAL: a failed wait logs gracefully rather
// than raising an unhandled rejection. `.stop()` cancels it.
interface AvsbGuardedThenable<T> extends PromiseLike<T> {
  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): AvsbGuardedThenable<R1 | R2>
  catch<R = never>(
    onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null
  ): AvsbGuardedThenable<T | R>
  finally(onFinally?: (() => void) | null): AvsbGuardedThenable<T>
  stop(): void
}

interface AvsbWaitUntilFn {
  /** Wait for a selector / `window.x.y` path / predicate to resolve. */
  <T = unknown>(target: AvsbWaitTarget<T>, opts?: AvsbWaitOptions): AvsbGuardedThenable<T>
  /** Wait for several targets at once; resolves with an array of results. */
  <T extends unknown[]>(targets: AvsbWaitTarget[], opts?: AvsbWaitOptions): AvsbGuardedThenable<T>
}

// --- Consent ---

/** Per-category consent flags. An absent key means "not expressed" (allowed). */
interface AvsbConsentState {
  analytics?: boolean
  marketing?: boolean
}

/**
 * Visitor consent, the hook your cookie banner calls. `set` persists for 1 year in
 * the first-party `avsb_consent` cookie and wins over the inferred Google signal.
 */
interface AvsbConsentApi {
  set(state: AvsbConsentState): void
  get(): AvsbConsentState
}

// --- Datasets ---

interface AvsbDatasetGetResult {
  found: boolean
  /** FEED only: the row's ordered items array. */
  items?: unknown[]
  /** TABLE only: the full row object. */
  row?: unknown
  /** LIST only: whether the key is a member of the list. */
  member?: boolean
  meta: { slug: string; version: number | null }
}

interface AvsbDatasetHandle {
  get(key: string): Promise<AvsbDatasetGetResult>
  has(key: string): Promise<boolean>
}

// --- Recommendations ---

interface AvsbRecProduct {
  id: string
  title?: string
  image?: string
  href?: string
  category?: string
  /** MINOR units (ISO-4217). */
  price?: number
  /** MINOR units. */
  compareAtPrice?: number
  currency?: string
  availability?: 'in_stock' | 'out_of_stock' | 'removed'
}

interface AvsbRecsRequest {
  recipe: string
  context?: { seed?: string; seeds?: string[]; recentlyViewed?: number }
  maxItems?: number
  excludeOutOfStock?: boolean
  /** Which rec surface this call serves, for multi-surface pages. */
  surface?: string
}

interface AvsbRecsResult {
  items: AvsbRecProduct[]
  served: boolean
  recipe: string
  /** Slug of the chain step that served, null on a miss. */
  source: string | null
  fallbackStep: number | null
  /** True when the resolve failed (timeout, network, HTTP, parse). */
  degraded: boolean
}

interface AvsbRecsClient {
  /** Resolve items for a recipe. Auto-fires rec:impression on success. Never throws. */
  get(req: AvsbRecsRequest): Promise<AvsbRecsResult>
  /** Fire a rec:click for a product the visitor clicked. */
  trackClick(productId: string, opts?: { position?: number }): void
  /** Record a product view (feeds recently-viewed and commerce audiences). */
  trackView(sku: string, meta?: { category?: string }): void
}

// --- Commerce data contract ---

interface AvsbContractProduct {
  /** Required. The merchant's product id. */
  sku: string
  /** Product-grain canonical key. Defaults to `sku`. */
  productKey?: string
  title?: string
  /** Major units as displayed. */
  price?: number
  /** Already-minor integer. Wins over `price`. */
  priceMinor?: number
  compareAtPrice?: number
  compareAtPriceMinor?: number
  currency?: string
  image?: string
  url?: string
  brand?: string
  category?: string
  categories?: string[]
  availability?: 'in_stock' | 'out_of_stock' | 'preorder'
  stock?: number
  variant?: { variantSku: string; options?: Record<string, string>; price?: number; priceMinor?: number; stock?: number }
  customFields?: Record<string, string | number | boolean>
  /** ms-epoch product createdAt. */
  createdAt?: number
}

interface AvsbContractCartLine {
  sku: string
  productKey?: string
  quantity: number
  price?: number
  priceMinor?: number
  variantSku?: string
}

interface AvsbContractCart {
  items: AvsbContractCartLine[]
  total?: number
  totalMinor?: number
  currency?: string
}

interface AvsbCommerceApi {
  productView(p: AvsbContractProduct): void
  /** Category / collection impressions. */
  productList(items: AvsbContractProduct[], meta?: { listId?: string }): void
  addToCart(line: AvsbContractCartLine): void
  removeFromCart(line: AvsbContractCartLine): void
  /** Full cart snapshot. */
  cart(cart: AvsbContractCart): void
  checkoutStep(step: { step: number | string; cart?: AvsbContractCart }): void
  search(q: { query: string; resultCount?: number; skus?: string[] }): void
  categoryView(c: { category: string; skus?: string[] }): void
  wishlist(w: { sku: string; action: 'add' | 'remove' }): void
}

// --- Utils toolkit (avsb.utils.* and options.utils.*) ---
interface AvsbCookieApi {
  get(name: string): string | null
  set(name: string, value: string, opts?: { days?: number; path?: string; domain?: string; sameSite?: 'Lax' | 'Strict' | 'None'; secure?: boolean }): void
  remove(name: string): void
}

interface AvsbKVStore {
  get<T = unknown>(key: string): T | null
  set(key: string, value: unknown): void
  remove(key: string): void
}

interface AvsbElementProps {
  class?: string
  id?: string
  text?: string
  html?: string
  attrs?: Record<string, string>
  style?: Record<string, string>
  on?: Record<string, EventListener>
}

interface AvsbUtils {
  /** Guarded, promise-based wait. `.catch()` optional; failures log gracefully. */
  waitUntil: AvsbWaitUntilFn
  /** Alias of waitUntil (Qubit `poll` compatibility). */
  poll: AvsbWaitUntilFn
  /** Resolve once a single selector is present. */
  waitForElement(selector: string, opts?: { timeout?: number; root?: ParentNode }): AvsbGuardedThenable<Element>
  /** Run a callback for each matching element, now and on future mutations. Supports shadow roots via `root`. */
  onMutation(selector: string, callback: (el: Element) => void, opts?: { root?: ParentNode; once?: boolean; attributes?: boolean }): { stop(): void }
  once<F extends (...args: never[]) => unknown>(fn: F): F
  throttle<F extends (...args: never[]) => void>(fn: F, ms: number): F & { cancel(): void }
  debounce<F extends (...args: never[]) => void>(fn: F, ms: number): F & { cancel(): void }
  raf(fn: FrameRequestCallback): { cancel(): void }
  idle(fn: () => void, opts?: { timeout?: number }): { cancel(): void }
  domReady(): AvsbGuardedThenable<void>
  retry<T>(fn: () => Promise<T> | T, opts?: { attempts?: number; delay?: number; factor?: number }): Promise<T>
  $(selector: string, root?: ParentNode): Element | null
  $$(selector: string, root?: ParentNode): Element[]
  createElement(tag: string, props?: AvsbElementProps, children?: (Node | string)[]): HTMLElement
  insertAfter(newNode: Node, ref: Node): void
  insertBefore(newNode: Node, ref: Node): void
  wrap(node: Node, wrapper: HTMLElement): void
  remove(node: Node): void
  setText(node: Node, text: string): void
  /** Sets innerHTML; scrubs scripts and handlers unless `{ raw: true }`. */
  setHtml(node: Element, html: string, opts?: { raw?: boolean }): void
  /** Direct listener, or (with a selector string target) a delegated listener that also catches future nodes. */
  on(target: EventTarget | string, type: string, handler: (event: Event, matched?: Element) => void, opts?: AddEventListenerOptions): { off(): void }
  /** Fires on client-side route changes. */
  onUrlChange(callback: (url: string) => void): { off(): void }
  cookie: AvsbCookieApi
  query: { get(name: string): string | null; getAll(): Record<string, string> }
  storage: { local: AvsbKVStore; session: AvsbKVStore }
  /** Share values between triggers.js and variation.js of the same experiment. */
  state: { get<T = unknown>(key: string): T | undefined; set(key: string, value: unknown): void }
  /** Scoped logger: debug/info emit only in debug, preview, or dev mode; warn always. */
  log: { debug(...args: unknown[]): void; info(...args: unknown[]): void; warn(...args: unknown[]): void }
}

// --- Experiment decisions ---

/** Why an experiment did or did not run for this visit. `variant` / `control` mean the visitor is IN the test. `self-redirect` also means IN the test: the visitor is bucketed to a split-URL variant whose destination is the page they are already on, so the redirect was refused instead of looped. `late` means the page's reveal deadline had passed before the experiment could be applied, so it was skipped whole for this page load and nobody was exposed. `unsupported` means this build of the snippet does not carry a feature the experiment needs, so it was skipped whole and reported. `error` stays the genuine failure bucket. */
type AvsbDecisionStatus = 'variant' | 'control' | 'trigger-pending' | 'self-redirect' | 'not-targeted' | 'audience-mismatch' | 'excluded' | 'traffic-holdout' | 'capped' | 'scheduled-off' | 'late' | 'unsupported' | 'error'

/** One row of `avsb.getExperimentDecisions()`. The variation fields are present only when a variation was assigned. */
interface AvsbExperimentDecision {
  experimentId: string
  status: AvsbDecisionStatus
  variationId?: string
  variationName?: string
}

// --- The global API ---

interface AvsbApi {
  /** Consent mode only: start the snippet once the visitor has agreed. No effect otherwise. */
  init(): void | Promise<void>
  /** Stop everything and forget the visitor: tracking off, timers and listeners cleared, variations reverted, visitor cookie expired. */
  disable(): void
  track: AvsbTrackFunction
  /** The visitor's id, or null when there isn't one (before `init()` in consent mode, or for a visitor who denied analytics). */
  getVisitorId(): string | null
  /** Replace the visitor id to stitch a browser onto a logged-in account. Drops sticky assignments and re-evaluates, so the variation can change. Returns false for an unusable id. */
  setVisitorId(visitorId: string): boolean
  /** The variation this visitor is assigned in the experiment, or null. Pass the numeric **Experiment ID** from the experiment details panel (a number or its string form); the value returned is that variation's numeric **Variation ID**. Internal UUIDs are not accepted. */
  getVariation(experimentId: string | number): string | null
  /** Force a variation, for QA, by the numeric **Experiment ID** and **Variation ID** shown in the experiment details panel. It stays the visitor's variation on later page loads until `exitPreview()`; `{ persist: false }` forces it for this page only. `{ track: false }` applies it without recording an exposure. */
  forceVariation(experimentId: string | number, variationId: string | number, options?: { track?: boolean; persist?: boolean }): boolean
  waitUntil: AvsbWaitUntilFn
  utils: AvsbUtils
  /** Subscribe to every experiment event. Returns an unsubscribe function. Absent in the preview bypass runtime. */
  on?(event: 'event', callback: (record: AvsbIntegrationRecord) => void): () => void
  /** Run a callback once experiments have been evaluated. Safe to call before the snippet loads. */
  ready?(callback: () => void): void
  /** @deprecated Use `ready`. Same machinery. */
  onReady(callback: () => void): void
  /** Visitor consent: `set` from your banner, `get` for the effective state. Absent in the preview bypass runtime. */
  consent?: AvsbConsentApi
  /** Experiments this visitor is active in on this page, as the same numeric dashboard ids `getVariation` takes, in string form. */
  getActiveExperiments(): Array<{ experimentId: string; variationId: string }>
  /** One row per experiment on the page: what happened to this visit and why (held out, mismatched, pending, running). Rebuilt on every evaluation; empty before evaluation and after `disable()`. Optional: absent on snippet builds that predate it, so read it as `avsb.getExperimentDecisions?.()`. */
  getExperimentDecisions?(): AvsbExperimentDecision[]
  /** Read a server-side dataset. Never throws: unknown slugs resolve `{ found: false }`. */
  dataset(slug: string): AvsbDatasetHandle
  /** Headless recommendations. Inside variation code prefer `options.recs`, which attributes automatically. */
  recs: AvsbRecsClient
  /** Commerce events. Buffered until the commerce chunk loads. */
  commerce: AvsbCommerceApi
  /** Leave a shared preview link and undo every persisted `forceVariation`: clears both and reloads. */
  exitPreview(): void
  /** After a split-URL redirect in this tab: the referrer of the page the visitor was redirected FROM, captured before the redirect so your analytics can undo the self-referral. `''` means that visit was direct; `null` means no redirect has happened (or storage is unavailable). Same-origin only, so a destination on a different domain cannot read it. Optional: absent on snippet builds that predate it, so read it as `avsb.getOriginalReferrer?.()`. */
  getOriginalReferrer?(): string | null
  /** Re-run every experiment against the page as it is now. For app-driven navigation the History API never sees. */
  refresh(): void
  /** The snippet build running on this page, e.g. `1.1.0`. */
  version: string
  /** Which of the four snippet files this page is running: `full`, `visual`, `shop` or `core`. Optional: absent on snippet builds that predate named files, and until the first install stamp lands. A build that does not name its file always carries everything, so treat an absent value as `full`. */
  buildVariant?: string
}

/** `window.avsb`. `q` is the install tag's early-call queue, drained by the runtime. */
interface Window {
  avsb: AvsbApi & { q?: Array<[string, ...unknown[]]> }
}

/** The same object as `window.avsb`, so `avsb.track.event(...)` reads cleanly. */
declare const avsb: AvsbApi
