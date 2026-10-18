# @avsbhq/snippet-types

TypeScript types for `window.avsb`, the A vs B web-snippet API.

Types only. Nothing is bundled, nothing runs, and your production build is
unchanged: the snippet itself arrives from the A vs B CDN through the install tag
you paste into your site.

## Install

```bash
npm install --save-dev @avsbhq/snippet-types
```

## Use it

These are global declarations, so add the package to `types` in your
`tsconfig.json` rather than importing it:

```json
{
  "compilerOptions": {
    "types": ["@avsbhq/snippet-types"]
  }
}
```

If you would rather not touch `types` (which replaces the default "include every
installed type package" behaviour), reference it from any `.d.ts` in your project
instead:

```ts
// docs-example: not typechecked here, because the A vs B repository does not install @avsbhq/snippet-types as a dependency, so the type reference has nothing to resolve against

/// <reference types="@avsbhq/snippet-types" />
```

Either way, `avsb` and `window.avsb` are typed everywhere, and every shape has a
name you can use:

```ts
avsb.ready?.(() => {
  avsb.track.event('signup_completed', { revenue: 49.99 });

  const variation: string | null = avsb.getVariation('exp_id_from_the_dashboard');
  if (variation) console.log('running', variation, 'on snippet', avsb.version);
});

function reportOrder(order: AvsbPurchaseOrder): void {
  avsb.track.purchase(order);
}

const unsubscribe = avsb.on?.('event', (record: AvsbIntegrationRecord) => {
  if (record.event_type === 'exposure') myAnalytics.track('AB exposure', { ...record });
});
unsubscribe?.();
```

`ready`, `on` and `consent` are optional on `AvsbApi` because the preview bypass
runtime does not define them, so reach them with `?.` as above.

`getVisitorId()` is typed `string | null`, because there is no visitor id before
`avsb.init()` in consent mode, and none at all for a visitor who denied
analytics:

```ts
const visitorId: string | null = avsb.getVisitorId();
if (visitorId) sendToYourBackend(visitorId);
```

## The names

`AvsbApi` is the type of `window.avsb`. The shapes it uses are all named too:
`AvsbTrackFunction`, `AvsbTrackEventProperties`, `AvsbPurchaseOrder`,
`AvsbPurchaseItem`, `AvsbIntegrationRecord`, `AvsbIntegrationEventType`,
`AvsbConsentApi`, `AvsbConsentState`, `AvsbDatasetHandle`,
`AvsbDatasetGetResult`, `AvsbRecsClient`, `AvsbRecsRequest`, `AvsbRecsResult`,
`AvsbRecProduct`, `AvsbCommerceApi`, `AvsbContractProduct`, `AvsbContractCart`,
`AvsbContractCartLine`, `AvsbUtils`, `AvsbWaitUntilFn`, `AvsbWaitTarget`,
`AvsbWaitOptions`, `AvsbGuardedThenable`, `AvsbCookieApi`, `AvsbKVStore`,
`AvsbElementProps`.

Every one of them is global, so no import is needed, and every one is stable:
names here are only added, never renamed or removed.

## Writing variation, trigger, or project code

Code written inside the A vs B editor gets an `options` toolkit and the
`initVariation` / `initTrigger` / `initProject` entry points. Those are authoring
globals, so they live behind a subpath and stay out of your site's global scope:

```json
{
  "compilerOptions": {
    "types": ["@avsbhq/snippet-types", "@avsbhq/snippet-types/variation-code"]
  }
}
```

```ts
function initVariation(options: AvsbVariationOptions): void {
  options.waitUntil<HTMLElement>('.hero h1').then((el) => {
    options.utils.setText(el, 'A clearer headline');
    options.track.event('hero_seen');
  });
}
```

The A vs B CLI (`avsb clone`) already writes this configuration for you when it
scaffolds a local experiment project.

## Calling the API before the snippet has loaded

The loader tag is `async`, so the API can arrive after your own code runs. The
install tag defines `avsb.ready`, `avsb.on`, `avsb.consent.set` and the four
`avsb.track.*` methods from the first byte of the page, so those calls are queued
and replayed. Everything else belongs inside `avsb.ready(...)`.

## Versioning

Published in lockstep with the rest of the `@avsbhq/*` family. The declarations
mirror the snippet runtime's own types, and a test in the A vs B repository fails
if the two drift apart.

## Links

- [Snippet SDK API reference](https://avsb.cloud/docs/developer-reference/snippet-sdk-api)
- [Tracking events](https://avsb.cloud/docs/developer-reference/tracking-events)
- [Debug mode](https://avsb.cloud/docs/troubleshooting/debug-mode)
