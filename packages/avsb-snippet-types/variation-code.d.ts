// TypeScript declarations for code you write INSIDE A vs B: variation code,
// trigger code, and project code. Companion to `avsb.d.ts`, which types the
// `window.avsb` global and must be loaded alongside this file.
//
// Kept separate because these are authoring globals (`options`, `activate`,
// `initVariation`, ...). A site consuming `@avsbhq/snippet-types` for
// `window.avsb` should not have them in its global scope, so they live behind
// the `@avsbhq/snippet-types/variation-code` subpath.
//
// SOURCE OF TRUTH. The dashboard code editor's copy at
// `snippet/types/variation-code.d.ts` is generated: run `npm run sync:types` in
// this package after editing. Mirrors `HarnessOptions` in
// `snippet/src/userCodeHarness.ts`.
//
// Not a module, for the same reason as `avsb.d.ts`: these are global names, and
// an `export` would hide all of them. Frozen at launch: rename nothing, add only.

/** What every user-code surface receives. Self-cleaning helpers are torn down for you. */
interface AvsbCodeOptions {
  /** Present in variation and trigger code. */
  experimentId?: string
  experimentName?: string
  variationId?: string
  variationName?: string
  variationType?: 'control' | 'variant'
  /** Present in project code only. */
  projectId?: string
  /** Runs when the variation is activated. In variation code it fires as soon as your function returns. */
  onActivation(cb: () => void): void
  /** Runs when the variation is removed (client-side navigation, teardown, forced switch). */
  onRemove(cb: () => void): void
  track: AvsbTrackFunction
  /** Impressions and clicks attribute to this variation automatically. */
  recs: AvsbRecsClient
  getVisitorId(): string | null
  /** The visitor's numeric **Variation ID** in that experiment, or null. Takes the numeric **Experiment ID** from the experiment details panel, NOT the `experimentId` above (that one is the internal id). */
  getVariation(experimentId: string | number): string | null
  /** Experiments running on this page, as the same numeric dashboard ids. */
  getActiveExperiments(): Array<{ experimentId: string; variationId: string }>
  /** Force a variation by the numeric **Experiment ID** and **Variation ID** from the experiment details panel. */
  forceVariation(experimentId: string | number, variationId: string | number, options?: { track?: boolean; persist?: boolean }): boolean
  /** Cancelled automatically on teardown, unlike `avsb.waitUntil`. */
  waitUntil: AvsbWaitUntilFn
  utils: AvsbUtils
  /** Same numeric handle as the browser's own. Cancelled for you on teardown. */
  setTimeout(handler: () => void, ms?: number): number
  setInterval(handler: () => void, ms?: number): number
  addEventListener(target: EventTarget, type: string, handler: EventListenerOrEventListenerObject, opts?: AddEventListenerOptions | boolean): void
}

type AvsbTriggerOptions = AvsbCodeOptions
type AvsbVariationOptions = AvsbCodeOptions
type AvsbProjectOptions = AvsbCodeOptions

// Ambient declarations for standalone authoring files. They look unused to
// ESLint because nothing in this declaration file references them: they are the
// names your own trigger, variation, and project code calls into, so they must
// stay literal.
/* eslint-disable @typescript-eslint/no-unused-vars */
declare const options: AvsbCodeOptions
declare function activate(): void
declare function deactivate(): void
declare function initVariation(options: AvsbVariationOptions): void
declare function initTrigger(options: AvsbTriggerOptions, activate: () => void, deactivate: () => void): void
declare function initProject(options: AvsbProjectOptions): void
/* eslint-enable @typescript-eslint/no-unused-vars */
