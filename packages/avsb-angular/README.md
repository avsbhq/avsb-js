# @avsbhq/angular

Angular SDK for [A vs B](https://app.avsb.cloud) feature flags and experiments.

Signals and Observables for the same flags, a structural directive with an
`else` branch, two pipes, and exposure tracking you control. Built with
ng-packagr, so it compiles under AOT in a normal Angular CLI application.

---

## 1. Install

```bash
npm install @avsbhq/angular
```

`@angular/core` (20 or later) and `rxjs` (7 or later) are peer dependencies,
so they come from your application. `@avsbhq/core` and `@avsbhq/browser` are
regular dependencies: you do not install them yourself.

---

## 2. Quickstart

### Standalone bootstrap

```ts
// main.ts
import { bootstrapApplication } from '@angular/platform-browser';
import { provideAvsb } from '@avsbhq/angular';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, {
  providers: [
    provideAvsb({
      sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
      context: { kind: 'user', key: 'anon_42' },
    }),
  ],
});
```

### NgModule bootstrap

```ts
// app.module.ts
import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';
import { AvsbModule } from '@avsbhq/angular';
import { AppComponent } from './app.component';

@NgModule({
  declarations: [AppComponent],
  imports: [BrowserModule, AvsbModule.forRoot({ sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn' })],
  bootstrap: [AppComponent],
})
export class AppModule {}
```

### Configure once

Call `provideAvsb()` (or `AvsbModule.forRoot()`) exactly once, at bootstrap.
Calling it again in a lazy route's providers builds a SECOND client for that
route: deliberate when you want a different context there, a duplicate
datafile fetch and a duplicate event queue when you do not. Components in that
route then resolve the route's client, and everything outside keeps the root
one.

Feature modules import plain `AvsbModule` (no `forRoot`) to get the
directives and pipes; that adds no providers, so they reuse the root client.

### Read a flag

```ts
import { Component } from '@angular/core';
import { avsbBoolFlagSignal, AVSB_TEMPLATE_FEATURES } from '@avsbhq/angular';
import type { Flag } from '@avsbhq/angular';
import type { Signal } from '@angular/core';

@Component({
  selector: 'app-checkout',
  standalone: true,
  imports: [AVSB_TEMPLATE_FEATURES],
  template: `
    @if (checkout().isEnabled()) {
      <app-new-checkout avsbExposure="checkout_v2" />
    } @else {
      <app-legacy-checkout />
    }
  `,
})
export class CheckoutComponent {
  readonly checkout: Signal<Flag<boolean>> = avsbBoolFlagSignal('checkout_v2', false);
}
```

Three things are true of that component and of every read in this package:

1. Reading a flag fires **no exposure event**. `avsbExposure` is what records
   that the visitor was shown the decision, so change detection can never
   inflate your results.
2. Before the datafile arrives, `checkout().value` is the default you passed
   and `checkout().source` is `'not_ready'`. Nothing is `undefined`.
3. The signal updates by itself when the flag changes in the dashboard.

---

## 3. SDK keys

There is one SDK key per environment, and it is the only credential this
package takes. There is no separate client key or server key.

Your SDK key is a public identifier, not a secret: it is safe to ship in
browser and mobile bundles, it can only fetch that environment's flag
configuration and send events, and it can never read or change anything in
your dashboard.

Find yours on [app.avsb.cloud](https://app.avsb.cloud) under
**Environments** in the project sidebar. Keys are shaped `sdk_<environment>_<id>`, so a
production key reads `sdk_production_...`.

```ts
// environments/environment.ts
export const environment = {
  avsbSdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
};
```

---

## 4. The whole type surface

Every export, with its real signature. The names in the shapes below come from
this package, from Angular, and from rxjs:

```ts
import type {
  EnvironmentProviders,
  InjectionToken,
  Injector,
  ModuleWithProviders,
  Signal,
  TemplateRef,
} from '@angular/core';
import { Directive, Input, Pipe } from '@angular/core';
import type { Observable } from 'rxjs';
import {
  AvsbExposureDirective,
  AvsbFlagDirective,
  AvsbFlagPipe,
  AvsbFlagStatePipe,
} from '@avsbhq/angular';
import type {
  AngularAvsbClient,
  AvsbClientOptions,
  AvsbConfig,
  AvsbInjectOptions,
  AvsbStatus,
  EvalContext,
  EvaluationSource,
  Flag,
  FlagDatafile,
  InitResult,
  TrackPayload,
} from '@avsbhq/angular';
```

### Configuration

```ts
function provideAvsb(config: AvsbConfig): EnvironmentProviders;

class AvsbModule {
  static forRoot(config: AvsbConfig): ModuleWithProviders<AvsbModule>;
}

const AVSB_TEMPLATE_FEATURES: readonly [
  typeof AvsbFlagDirective,
  typeof AvsbExposureDirective,
  typeof AvsbFlagPipe,
  typeof AvsbFlagStatePipe,
];

const AVSB_CONFIG: InjectionToken<AvsbConfig>;
const AVSB_CLIENT: InjectionToken<AngularAvsbClient>;
```

```ts
type AvsbConfig = (AvsbClientOptions & { client?: never }) | { client: AngularAvsbClient };
```

Mode A passes `sdkKey` and any other `AvsbClientOptions`; this package builds
the client and closes it when the injector is destroyed. Mode B passes a
client you built yourself, which this package never closes.

`AvsbClientOptions` is re-exported unchanged from `@avsbhq/browser`; see that
package's README for every option (`pollingInterval`, `bootstrap`, `logLevel`,
`streaming`, and the rest).

### `AvsbService`

Declared `@Injectable({ providedIn: 'root' })` and implementing `OnDestroy`, so
it is injectable anywhere and torn down with the injector:

```ts
class AvsbService {
  readonly client: AngularAvsbClient;

  // Status
  readonly status: Signal<AvsbStatus>;
  readonly status$: Observable<AvsbStatus>;
  readonly ready: Signal<boolean>;
  readonly ready$: Observable<boolean>;
  readonly degraded: Signal<boolean>;
  readonly degraded$: Observable<boolean>;
  readonly error: Signal<Error | null>;
  readonly error$: Observable<Error | null>;
  isReady(): boolean;
  onReady(options?: { timeout?: number }): Promise<InitResult>;

  // Reads, as Observables
  getFlag<T>(flagKey: string, defaultValue: T): Observable<Flag<T>>;
  getFlagValue<T>(flagKey: string, defaultValue: T): Observable<T>;
  getBoolFlag(flagKey: string, defaultValue: boolean): Observable<Flag<boolean>>;
  getStringFlag(flagKey: string, defaultValue: string): Observable<Flag<string>>;
  getNumberFlag(flagKey: string, defaultValue: number): Observable<Flag<number>>;
  getJsonFlag<T>(flagKey: string, defaultValue: T): Observable<Flag<T>>;
  getAllFlags(): Observable<Record<string, Flag>>;
  snapshot<T>(flagKey: string, defaultValue: T): Flag<T>;

  // Reads, as Signals (injection context required, see section 5)
  flagSignal<T>(flagKey: string, defaultValue: T, options?: AvsbInjectOptions): Signal<Flag<T>>;
  flagValueSignal<T>(flagKey: string, defaultValue: T, options?: AvsbInjectOptions): Signal<T>;
  boolFlagSignal(
    flagKey: string,
    defaultValue: boolean,
    options?: AvsbInjectOptions,
  ): Signal<Flag<boolean>>;
  stringFlagSignal(
    flagKey: string,
    defaultValue: string,
    options?: AvsbInjectOptions,
  ): Signal<Flag<string>>;
  numberFlagSignal(
    flagKey: string,
    defaultValue: number,
    options?: AvsbInjectOptions,
  ): Signal<Flag<number>>;
  jsonFlagSignal<T>(flagKey: string, defaultValue: T, options?: AvsbInjectOptions): Signal<Flag<T>>;
  allFlagsSignal(options?: AvsbInjectOptions): Signal<Record<string, Flag>>;

  // Exposure
  recordExposure(flagKey: string, defaultValue?: unknown): () => void;

  // Identity and events
  identify(context: EvalContext): void;
  alias(previousContext: EvalContext, newContext: EvalContext): void;
  reset(): void;
  track(eventKey: string, payload?: TrackPayload): void;
  flush(): Promise<void>;

  // Teardown
  destroy(): void;
  ngOnDestroy(): void;
}
```

Injecting `AvsbService` in an application that called neither `provideAvsb()`
nor `AvsbModule.forRoot()` throws, with a message naming the call to add. The
alternative was an application that silently served default values forever.

### Standalone helpers

Each helper is the terse form of the matching service method. Every name
carries the `avsb` prefix, so nothing here can collide with a `track` or
`identify` of your own.

```ts
// Observables
function avsbFlag$<T>(
  flagKey: string,
  defaultValue: T,
  options?: AvsbInjectOptions,
): Observable<Flag<T>>;
function avsbFlagValue$<T>(
  flagKey: string,
  defaultValue: T,
  options?: AvsbInjectOptions,
): Observable<T>;
function avsbBoolFlag$(
  flagKey: string,
  defaultValue: boolean,
  options?: AvsbInjectOptions,
): Observable<Flag<boolean>>;
function avsbStringFlag$(
  flagKey: string,
  defaultValue: string,
  options?: AvsbInjectOptions,
): Observable<Flag<string>>;
function avsbNumberFlag$(
  flagKey: string,
  defaultValue: number,
  options?: AvsbInjectOptions,
): Observable<Flag<number>>;
function avsbJsonFlag$<T>(
  flagKey: string,
  defaultValue: T,
  options?: AvsbInjectOptions,
): Observable<Flag<T>>;
function avsbAllFlags$(options?: AvsbInjectOptions): Observable<Record<string, Flag>>;
function avsbStatus$(options?: AvsbInjectOptions): Observable<AvsbStatus>;
function avsbReady$(options?: AvsbInjectOptions): Observable<boolean>;
function avsbError$(options?: AvsbInjectOptions): Observable<Error | null>;
function avsbDegraded$(options?: AvsbInjectOptions): Observable<boolean>;

// Signals
function avsbFlagSignal<T>(
  flagKey: string,
  defaultValue: T,
  options?: AvsbInjectOptions,
): Signal<Flag<T>>;
function avsbFlagValueSignal<T>(
  flagKey: string,
  defaultValue: T,
  options?: AvsbInjectOptions,
): Signal<T>;
function avsbBoolFlagSignal(
  flagKey: string,
  defaultValue: boolean,
  options?: AvsbInjectOptions,
): Signal<Flag<boolean>>;
function avsbStringFlagSignal(
  flagKey: string,
  defaultValue: string,
  options?: AvsbInjectOptions,
): Signal<Flag<string>>;
function avsbNumberFlagSignal(
  flagKey: string,
  defaultValue: number,
  options?: AvsbInjectOptions,
): Signal<Flag<number>>;
function avsbJsonFlagSignal<T>(
  flagKey: string,
  defaultValue: T,
  options?: AvsbInjectOptions,
): Signal<Flag<T>>;
function avsbAllFlagsSignal(options?: AvsbInjectOptions): Signal<Record<string, Flag>>;
function avsbStatusSignal(options?: AvsbInjectOptions): Signal<AvsbStatus>;
function avsbReadySignal(options?: AvsbInjectOptions): Signal<boolean>;
function avsbErrorSignal(options?: AvsbInjectOptions): Signal<Error | null>;
function avsbDegradedSignal(options?: AvsbInjectOptions): Signal<boolean>;

// Actions
function avsbTrack(eventKey: string, payload?: TrackPayload, options?: AvsbInjectOptions): void;
function avsbIdentify(context: EvalContext, options?: AvsbInjectOptions): void;
function avsbAlias(
  previousContext: EvalContext,
  newContext: EvalContext,
  options?: AvsbInjectOptions,
): void;
function avsbReset(options?: AvsbInjectOptions): void;
function avsbRecordExposure(
  flagKey: string,
  defaultValue?: unknown,
  options?: AvsbInjectOptions,
): () => void;
```

```ts
interface AvsbInjectOptions {
  injector?: Injector;
}

type AvsbStatus = 'loading' | 'ready' | 'error';
```

### Template features

```ts
@Directive({ selector: '[avsbFlag]', standalone: true })
class AvsbFlagDirective {
  @Input({ required: true }) avsbFlag!: string;
  @Input() avsbFlagDefault: unknown = false;
  @Input() avsbFlagWhenVariation?: string;
  @Input() avsbFlagWhenValue?: unknown;
  @Input() avsbFlagElse: TemplateRef<unknown> | null = null;
  @Input() avsbFlagExposure = false;
}

@Directive({ selector: '[avsbExposure]', standalone: true })
class AvsbExposureDirective {
  @Input({ required: true }) avsbExposure!: string;
  @Input() avsbExposureDefault: unknown = null;
}
```

The two pipes are declared `@Pipe({ name: 'avsbFlag', standalone: true, pure: false })`
and `@Pipe({ name: 'avsbFlagState', standalone: true, pure: false })`. Impure on
purpose: a pure pipe would cache the first value and never see the flag change.

```ts
class AvsbFlagPipe {
  transform<T>(flagKey: string, defaultValue: T): T;
}

class AvsbFlagStatePipe {
  transform<T>(flagKey: string, defaultValue: T): Flag<T>;
}
```

### Types re-exported for convenience

`Flag`, `EvalContext`, `SingleContext`, `MultiContext`, `TrackPayload`,
`InitResult`, `EvaluationSource`, `RuleType`, `ClientEventMap`,
`ClientEventName`, `FlagDatafile` and its sub-types, `Logger`,
`AvsbClientOptions`, `GetFlagOptions`, `GetAllFlagsOptions`, plus the
`DecideOption` const object and the `createFlag` / `notFoundFlag` /
`notReadyFlag` factories.

### Typed flag keys

Every `flagKey` above is `string` until you generate your keys. Generate them
and it becomes the union of this project's real flag keys, so a typo is a
compile error and your editor completes the list:

```bash
npx @avsbhq/cli codegen --output src/generated/flags.ts
```

The generated file declares your flags twice on purpose: an importable
`FlagValues` interface for payload types, and a `declare global` block that
teaches the service, the helpers, the pipes and the directives which keys exist.
Its important parts:

```text
// AUTO-GENERATED by @avsbhq/cli codegen. Do not edit by hand.

export interface FlagValues {
  'checkout_v2': boolean
  'hero_copy': 'control' | 'variant_a'
  'theme': { primary: string }
}

declare global {
  interface AvsbFlags {
    'checkout_v2': boolean
    'hero_copy': 'control' | 'variant_a'
    'theme': { primary: string }
  }
}
```

```ts
import { avsbBoolFlagSignal, avsbJsonFlagSignal } from '@avsbhq/angular';
import type { FlagValues } from './generated/flags';

class TypedCheckoutComponent {
  readonly checkout = avsbBoolFlagSignal('checkout_v2', false);

  // A JSON flag types its payload from the generated table:
  readonly theme = avsbJsonFlagSignal<FlagValues['theme']>('theme', { primary: '#111' });

  // Once the generated file exists, this line stops compiling:
  // 'chekcout_v2' is not a flag key.
  readonly typo = avsbBoolFlagSignal('chekcout_v2', false);
}
```

One real consequence in templates: a literal binding such as
`*avsbFlag="'checkout_v2'"` or `{{ 'hero_copy' | avsbFlag: 'control' }}` is
checked against your keys and otherwise unaffected. A binding that passes a
computed string, `[avsbFlag]="someKey"`, needs the same cast on `someKey` that
TypeScript code does.

Nothing changes for a project that never runs `codegen`: with no generated file
the table is empty, every `flagKey` is exactly `string`, and every call and
binding you have already written compiles unchanged. For a key computed at
runtime, widen deliberately with `key as AvsbFlagKey` (that type is exported
from `@avsbhq/core`).

---

## 5. Injection context: what needs one

Some helpers ask Angular for the current injector. Angular only offers one
while it is constructing something.

**Safe anywhere:**

- every method on an injected `AvsbService` that returns an `Observable`
  (`getFlag`, `getFlagValue`, the typed getters, `getAllFlags`);
- `snapshot()`, which answers synchronously with a `Flag<T>`;
- every action on it (`track`, `identify`, `alias`, `reset`,
  `recordExposure`);
- the directives and pipes, which Angular constructs for you.

**Needs an injection context, or an explicit `injector`:**

- every standalone helper, because it has to find `AvsbService`;
- every `*Signal` method and helper, because the injector also decides when
  the subscription is released.

An injection context is: a field initializer, a constructor, a factory
function, and anything inside `runInInjectionContext()`. It is **not**
`ngOnInit`, an event handler, a `setTimeout` callback, or a promise
continuation.

```ts
import { Component, inject, Injector, OnInit, Signal } from '@angular/core';
import { avsbFlagSignal } from '@avsbhq/angular';
import type { Flag } from '@avsbhq/angular';

@Component({ selector: 'app-hero', standalone: true, template: '' })
export class HeroComponent implements OnInit {
  // Field initializer: an injection context, so no options are needed.
  readonly hero: Signal<Flag<string>> = avsbFlagSignal('homepage_hero', 'control');

  private readonly injector = inject(Injector);
  late: Signal<Flag<string>> | null = null;

  ngOnInit(): void {
    // Lifecycle hook: not an injection context, so pass the injector.
    this.late = avsbFlagSignal('late_flag', 'control', { injector: this.injector });
  }
}
```

Called outside an injection context with no `injector`, a helper throws
Angular's NG0203 naming the helper you called.

---

## 6. Reading flags

### Signals

```ts
readonly hero: Signal<Flag<string>> = avsbStringFlagSignal('homepage_hero', 'control')
readonly heroValue: Signal<string> = avsbFlagValueSignal('homepage_hero', 'control')
```

The signal holds a `Flag` from the moment it is created: the first value is
read synchronously, so the type is `Signal<Flag<string>>` and never
`Signal<Flag<string> | undefined>`.

### Observables

```ts
private readonly avsb = inject(AvsbService)
readonly hero$: Observable<Flag<string>> = this.avsb.getStringFlag('homepage_hero', 'control')
```

```html
@if (hero$ | async; as hero) {
<app-hero [variant]="hero.value" />
}
```

`async` is Angular's own `AsyncPipe`, from `@angular/common`. This package
does not import `@angular/common`, so it is not a peer dependency here.

Each Observable emits the current value on subscribe, then once per change to
that flag. An unrelated flag changing does not emit. It never errors and
never completes, so `catchError` is unnecessary.

### In a template, with the structural directive

```html
<!-- the flag is on for this visitor -->
<section *avsbFlag="'new_dashboard'">...</section>

<!-- with a fallback branch -->
<section *avsbFlag="'new_dashboard'; else legacyDashboard">...</section>
<ng-template #legacyDashboard>...</ng-template>

<!-- one variation of a multivariate flag, by variation key -->
<section *avsbFlag="'hero'; default: 'control'; whenVariation: 'variant_a'">...</section>

<!-- or by the value that variation carries -->
<section *avsbFlag="'hero'; default: 'control'; whenValue: 'blue'">...</section>

<!-- record the exposure when this branch is shown -->
<section *avsbFlag="'new_dashboard'; exposure: true">...</section>
```

With no matcher, the directive renders when `flag.isEnabled()` is true.

`whenVariation` compares `Flag.variationKey`, the name shown in the
dashboard. `whenValue` compares `Flag.value` with `Object.is`, so a falsy
value such as `0` or `''` matches correctly. Setting both means both must
match, and the package logs a warning saying so.

### In a template, with the pipes

```html
<h1>{{ 'homepage_hero' | avsbFlag: 'Welcome' }}</h1>

@let state = 'checkout_v2' | avsbFlagState: false; @if (state.source === 'not_ready') {
<app-skeleton />
} @else if (state.isEnabled()) {
<app-new-checkout />
}
```

`avsbFlag` gives the value, typed from the default you pass. `avsbFlagState`
gives the whole `Flag`, which is how a template tells "no datafile yet" apart
from a real `false`.

Both pipes are impure: flag values change over time rather than when the
template's inputs change. Each subscribes once per key and marks the view for
check on updates, so `OnPush` components re-render.

Keep the default value stable. A pipe re-subscribes when the key OR the
default changes, and an object or array literal written inline in the template
(`| avsbFlagState: { retries: 3 }`) is a new object on every change detection
pass, so it would re-subscribe every pass. Hoist it to a field and pass that:

```ts
readonly apiConfigDefault = { timeout: 5000, retries: 3 }
```

```html
{{ 'api_config' | avsbFlag: apiConfigDefault }}
```

Primitive defaults (`false`, `0`, `'control'`) need no such care.

---

## 7. The `Flag<T>` object

Every read answers with this shape, from `@avsbhq/core`:

```ts
interface Flag<T = unknown> {
  /** The variation value typed against the default. */
  readonly value: T;
  /** Variation key (null if served the default or not found). */
  readonly variationKey: string | null;
  /** Why this value was produced. */
  readonly source: EvaluationSource;
  /** Rule that matched (null when no rule applied). */
  readonly ruleId: string | null;
  /** Rule type that matched (null when no rule applied). */
  readonly ruleType: RuleType | null;
  /** Structured reasons for this decision. */
  readonly reasons: string[];
  /** ms-epoch when evaluated. */
  readonly evaluatedAt: number;
  /** Microseconds elapsed in the evaluator. */
  readonly durationMicros: number;
  /** Convenience: a real decision produced a truthy value. */
  isEnabled(): boolean;
  /** Convenience: false for 'not_found' and for 'not_ready'. */
  exists(): boolean;
}

type RuleType = 'targeted_delivery' | 'ab_test' | 'holdout' | 'bandit';
```

The object is frozen, and the same object comes back on every read until that
flag's value changes.

### `EvaluationSource`, member by member

| Member             | Meaning                                                                | `isEnabled()`   | `exists()` |
| ------------------ | ---------------------------------------------------------------------- | --------------- | ---------- |
| `datafileOverride` | A per-user override configured in the dashboard matched.               | value-dependent | true       |
| `runtimeOverride`  | A runtime override set on the client matched.                          | value-dependent | true       |
| `sticky`           | A previously stored assignment was reused.                             | value-dependent | true       |
| `rule`             | A targeting rule or A/B rule matched.                                  | value-dependent | true       |
| `holdout`          | The visitor is in a holdout.                                           | value-dependent | true       |
| `bandit`           | A bandit rule picked the variation.                                    | value-dependent | true       |
| `default`          | The flag exists, nothing matched, its default variation was served.    | false           | true       |
| `disabled`         | The flag exists but is switched off in this environment.               | false           | true       |
| `not_found`        | The datafile loaded and does not contain this key. Check the key name. | false           | false      |
| `not_ready`        | The SDK has no datafile yet. Wait for `ready`, or pass `bootstrap`.    | false           | false      |

"value-dependent" means `isEnabled()` is `Boolean(flag.value)`.

### Typed reads and mismatches

`getBoolFlag`, `getStringFlag`, `getNumberFlag` and their signal and helper
forms check the value against the type the platform declared for that flag.
**A mismatch never throws.** The SDK logs one warning naming the flag and the
getter, then answers with your `defaultValue` and `source: 'not_found'`.

`getJsonFlag<T>` checks only that the flag is declared as JSON. `T` is your
assertion about the payload shape, not a runtime check: validate it yourself
if it crosses a trust boundary.

`getFlag<T>` runs no type check at all. `T` comes from your type argument
when you give one, and from the default value when you do not.

---

## 8. Status, readiness and errors

```ts
readonly status: Signal<AvsbStatus>       // 'loading' | 'ready' | 'error'
readonly ready: Signal<boolean>
readonly degraded: Signal<boolean>
readonly error: Signal<Error | null>
```

| Situation                                                      | `status`    | `degraded` | `error`           |
| -------------------------------------------------------------- | ----------- | ---------- | ----------------- |
| The first datafile load is in flight.                          | `'loading'` | false      | null              |
| The datafile loaded.                                           | `'ready'`   | false      | null              |
| A cached datafile is being served after a failed refresh.      | `'ready'`   | **true**   | the refresh error |
| Nothing could be loaded. Every flag answers with your default. | `'error'`   | false      | the init error    |
| A later refresh rescued a failed load.                         | `'ready'`   | false      | null              |

Degraded is a warning, never a failure: the values are real, they may be out
of date, and polling continues behind them. The SDK emits an error event on
its way to a degraded state, and this package deliberately does not treat
that event as fatal.

```ts
@Component({
  /* ... */
})
export class AppComponent {
  private readonly avsb = inject(AvsbService);
  readonly status = this.avsb.status;
  readonly error = this.avsb.error;
}
```

```html
@if (status() === 'error') {
<app-banner [text]="error()?.message ?? 'Flags unavailable'" />
}
```

`error()?.message` is written for a person: it names what failed, the value
involved, and where to fix it.

For a one-shot check, `onReady()` resolves when the init attempt settles and
never rejects:

```ts
export class ReadyGate {
  private readonly avsb = inject(AvsbService);

  async load(): Promise<void> {
    const result: InitResult = await this.avsb.onReady({ timeout: 2000 });
    if (!result.success) {
      // result.error.message names the URL tried and the fix.
    }
  }
}
```

The `timeout` bounds how long you wait, not what the SDK does: loading
continues behind it.

---

## 9. Exposure: keeping experiment results honest

Reads in this package fire no exposure event. That is what makes them safe to
call during change detection, which Angular may do many times per second.

Record the exposure where the decision is actually shown:

```html
<section *avsbFlag="'checkout_v2'">
  <app-new-checkout avsbExposure="checkout_v2" />
</section>
```

or let the structural directive do it when the branch appears:

```html
<section *avsbFlag="'checkout_v2'; exposure: true">
  <app-new-checkout />
</section>
```

or from TypeScript, when the variation arrives as an input from elsewhere:

```ts
private readonly avsb = inject(AvsbService)

ngOnInit(): void {
  this.avsb.recordExposure('checkout_v2')
}
```

Called before the SDK is ready, `recordExposure` waits for the first datafile
and records then. It returns a cancel function for that wait, which the
`avsbExposure` directive calls if the element is destroyed first: a visitor
who never saw the variation should not appear in the results.

---

## 10. Identity

```ts
const avsb = inject(AvsbService);

// After sign-in
avsb.identify({ kind: 'user', key: 'user_123', plan: 'pro', country: 'GB' });

// Link the anonymous visitor to the account, once, at sign-in, and after
// identify(): the event is attributed to the identity the client is bound to
avsb.alias({ kind: 'user', key: 'anon_42' }, { kind: 'user', key: 'user_123' });

// On sign-out
avsb.reset();
```

`identify` replaces the whole context and re-evaluates every flag
immediately, so subscribed components and signals update.

Target on several dimensions at once with a multi-context:

```ts
avsb.identify({
  kind: 'multi',
  user: { kind: 'user', key: 'user_123', plan: 'pro' },
  organization: { kind: 'organization', key: 'org_456', tier: 'enterprise' },
});
```

---

## 11. Tracking events

```ts
avsb.track('checkout_clicked');

avsb.track('purchase_completed', {
  value: 149.99,
  properties: { currency: 'GBP', productId: 'prod_123' },
});
```

```ts
interface TrackPayload {
  /** Numeric metric value. Generalises 'revenue': any quantity. */
  value?: number;
  /** Free-form properties forwarded to analytics. */
  properties?: Record<string, unknown>;
  /** Ignored by browser SDKs; the bound context is always used. */
  context?: EvalContext;
}
```

Events are batched. `avsb.flush()` sends what is queued now, which is worth
doing before a full page navigation.

---

## 12. Testing

Mode B is the whole testing story: provide a client, and every read in your
components answers from it.

```ts
import { TestBed } from '@angular/core/testing';
import { provideAvsb, createFlag } from '@avsbhq/angular';
import type { AngularAvsbClient, Flag } from '@avsbhq/angular';
import { CheckoutComponent } from './checkout.component';

const enabled: Flag<boolean> = createFlag<boolean>({
  value: true,
  variationKey: 'on',
  source: 'rule',
  ruleId: 'rule_1',
  ruleType: 'ab_test',
  reasons: ['matched rule rule_1'],
});

const client: AngularAvsbClient = {
  // ... the AngularAvsbClient members your component reaches
} as AngularAvsbClient;

TestBed.configureTestingModule({
  imports: [CheckoutComponent],
  providers: [provideAvsb({ client })],
});
```

`AngularAvsbClient` is the exact surface a stand-in has to satisfy, and it is
exported for that reason. The service calls four of its methods while it is
being constructed, so those are the ones a stand-in always needs:
`getInitResult()`, `isReady()`, `onReady()`, and `on()` (twice: once for
`'ready'`, once for `'error'`). Reads then use `subscribe(flagKey, listener)`
and `getSnapshot(flagKey, defaultValue)`, or the typed getters with
`{ readOnly: true }`.

`AvsbService` takes no constructor arguments: it reads `AVSB_CLIENT` and
`AVSB_CONFIG` with `inject()`. To build one without `TestBed`, give it an
injector carrying those two tokens:

```ts
import { Injector, runInInjectionContext } from '@angular/core';
import { AVSB_CLIENT, AVSB_CONFIG, AvsbService } from '@avsbhq/angular';

const injector = Injector.create({
  providers: [
    { provide: AVSB_CLIENT, useValue: client },
    { provide: AVSB_CONFIG, useValue: { client } },
  ],
});
const service = runInInjectionContext(injector, () => new AvsbService());
```

---

## 13. Server rendering

There is no Angular Universal integration yet. Under SSR the SDK renders
default values, then the browser evaluates for real once the datafile
arrives.

If you already fetch the datafile on the server, pass it as `bootstrap` so
the browser starts ready instead of fetching again:

```ts
declare const datafileFromTheServer: FlagDatafile;

provideAvsb({
  sdkKey: 'sdk_production_ttqm0eaj4vth1krcb2xn',
  bootstrap: datafileFromTheServer,
});
```

---

## 14. Shutdown

In Mode A the client is closed when the injector that provided it is
destroyed, which flushes queued events. In Mode B nothing is closed: the
client is yours. `avsb.destroy()` does the same work by hand.

---

## 15. Breaking changes in this release

Every public name is final. There are no deprecated aliases.

| Before                                                                                                   | Now                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `flag$`, `flagValue$`, `boolFlag$`, `stringFlag$`, `numberFlag$`, `jsonFlag$`, `allFlags$`, `flagReady$` | `avsbFlag$`, `avsbFlagValue$`, `avsbBoolFlag$`, `avsbStringFlag$`, `avsbNumberFlag$`, `avsbJsonFlag$`, `avsbAllFlags$`, `avsbReady$` |
| `track`, `identify`, `alias`                                                                             | `avsbTrack`, `avsbIdentify`, `avsbAlias`                                                                                             |
| `boolFlag$` and friends emitted a bare value                                                             | the typed helpers emit `Flag<T>`; use `avsbFlagValue$` for a bare value                                                              |
| `AvsbModuleConfig`                                                                                       | `AvsbConfig`                                                                                                                         |
| `service.client$` (a mutable `BehaviorSubject`)                                                          | `service.client` (the client itself)                                                                                                 |
| `*avsbFlag="'k'; when: 'v'"` compared the value                                                          | `whenVariation` compares the variation key, `whenValue` compares the value                                                           |
| a missing client left the SDK silently serving defaults                                                  | injecting `AvsbService` without `provideAvsb()` throws                                                                               |
| the pipe could return the default in place of a real value                                               | the pipe returns the served value; `avsbFlagState` exposes `not_ready` and `not_found`                                               |
| built with tsup (no Ivy metadata, unusable under AOT)                                                    | built with ng-packagr (Angular Package Format, partial Ivy)                                                                          |
| peer `@angular/core >= 17`, `@angular/common`                                                            | peer `@angular/core >= 20`; `@angular/common` is not imported and is no longer a peer                                                |

New in this release: the whole signal API, `avsbFlagState`, `avsbExposure`
and `recordExposure`, `else` templates on `*avsbFlag`, `degraded` and
`error` surfaces, `avsbReset`, and `AVSB_TEMPLATE_FEATURES`.

---

## 16. Migration from other tools

### From LaunchDarkly

| LaunchDarkly                           | @avsbhq/angular                                                |
| -------------------------------------- | -------------------------------------------------------------- |
| `LDClient.variation(key, default)`     | `avsbFlagSignal(key, default)` or `avsb.getFlag(key, default)` |
| `ldClient.boolVariation(key, default)` | `avsbBoolFlagSignal(key, default)`                             |
| `ldClient.allFlags()`                  | `avsbAllFlagsSignal()`                                         |
| `ldClient.on('change', cb)`            | subscribe to `avsb.getFlag(...)`, or read the signal           |
| `ldClient.identify(context)`           | `avsb.identify(context)`                                       |
| `ldClient.track(key, data, metric)`    | `avsb.track(key, { properties, value })`                       |
| `ldClient.waitForInitialization()`     | `avsb.onReady()`                                               |

LaunchDarkly returns a bare value; this SDK returns a `Flag`, so read
`flag.value` for the value and `flag.isEnabled()` for the on/off question.

### From Statsig

| Statsig                                     | @avsbhq/angular                       |
| ------------------------------------------- | ------------------------------------- |
| `*stgCheckGate="'gate'"`                    | `*avsbFlag="'flag'"`                  |
| `useGateValue` (logs an exposure)           | read plus `avsbExposure`              |
| `checkGate` (no exposure)                   | any read in this package              |
| `getExperiment(name).get('param', default)` | `avsbJsonFlagSignal<T>(key, default)` |

---

## 17. Set this up with your AI assistant

Paste this into Claude Code, Cursor, or any coding assistant:

```text
Set up A vs B feature flags in this Angular project.

1. Run: npx @avsbhq/cli init
   Use my saved CLI login: do not ask me for a token and do not put one in any file.
   It detects Angular and writes an example component. Angular has no environment
   file convention, so the SDK key goes in the code: an A vs B SDK key is a public
   identifier and is expected to ship in the bundle.
2. Install @avsbhq/angular with this project's package manager.
3. Call provideAvsb({ sdkKey, context: { kind: 'user', key: <your user id> } })
   exactly once at bootstrap, or AvsbModule.forRoot(...) in an NgModule app. Keep
   the key in src/environments/environment.ts if you keep one per build target.
4. Read flags with avsbBoolFlagSignal(key, false). The signal holds a Flag object,
   so call flag().value or flag().isEnabled(), and always pass a fallback. Reading
   a flag records nothing: put avsbExposure="key" on the element that shows the
   variation.
5. Then run: npx @avsbhq/cli codegen

Done looks like: the app starts, the flag reads without throwing, and avsb init
prints the line confirming it saw the first check-in.
```

`avsb init` ends by waiting for your app's first check-in and printing what it
saw, so the terminal tells you it works rather than the dashboard.
