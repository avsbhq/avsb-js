# @avsbhq/core

Pure evaluation engine, shared types, and schemas for the A vs B SDK ecosystem.

This package is the foundation that every other A vs B SDK package builds on. It contains no I/O, no DOM, no Node.js APIs, just the evaluator, type definitions, and shared helpers that all runtimes share.

**Most application code should not import this package directly.** Use `@avsbhq/browser`, `@avsbhq/node`, `@avsbhq/react`, or another runtime-specific package instead. Those packages re-export everything from `@avsbhq/core` you need at the application layer.

---

## 1. Install

```bash
npm install @avsbhq/core
```

Compatible with any JavaScript runtime: Node.js 18+, modern browsers, Cloudflare Workers, Deno, Bun, and React Native (Hermes).

No peer dependencies.

---

## 2. Quickstart

The primary use of `@avsbhq/core` in application code is importing its types. If you are building a per-language port of the A vs B SDK, use the `/engine` subpath for the evaluation primitives.

```ts
// Import types for type annotations in your own code
import type { EvalContext, Flag, TrackPayload, FlagDatafile } from '@avsbhq/core';

// Import the createFlag helper to construct Flag<T> objects in tests
import { createFlag, notFoundFlag } from '@avsbhq/core';

// Engine primitives: only for SDK implementors, not application code
import { evaluateFlag, murmurhash3 } from '@avsbhq/core/engine';
```

For application-level flag evaluation, use the runtime SDKs:

```ts
// Browser / client-side:
import { AvsbClient } from '@avsbhq/browser';

// Server / Node.js:
import { AvsbServer } from '@avsbhq/node';
```

---

## 3. SDK keys

Not applicable to `@avsbhq/core`. This package contains no networking code. SDK key handling lives in `@avsbhq/browser` (client keys) and `@avsbhq/node` (server keys).

---

## 4. Identity: `EvalContext`

`EvalContext` is the kinded context type used across every SDK. It replaces the legacy flat `{ attributes: Record<string, unknown> }` bag.

The shapes below and the `Flag<T>` shape in section 6 name a few more of the package's own types. They all come from the same entry point:

```ts
import type { ContextMeta, EvaluationSource, RuleType } from '@avsbhq/core';
```

```ts
export type EvalContext = SingleContext | MultiContext;

// Single-kind context: the common case
interface SingleContext {
  kind: string; // 'user' is conventional; any string is valid
  key: string; // bucketing identifier (unique per kind)
  name?: string; // optional display name, never used in eval
  _meta?: ContextMeta;
  [attribute: string]: unknown; // targeting attributes
}

// Multi-kind context: user + organization + device simultaneously
interface MultiContext {
  kind: 'multi';
  [contextKind: string]: SingleContext | 'multi';
}
```

Examples:

```ts
// Single context
const userCtx: EvalContext = {
  kind: 'user',
  key: 'u_123',
  plan: 'pro',
  country: 'US',
};

// Multi context
const multiCtx: EvalContext = {
  kind: 'multi',
  user: { kind: 'user', key: 'u_123', plan: 'pro' },
  organization: { kind: 'organization', key: 'org_456', tier: 'enterprise' },
};
```

Context helper functions exported from `@avsbhq/core`:

```ts
import {
  isMultiContext,
  getContextByKind,
  userContext,
  bucketingKey,
  contextSummary,
  privateAttributesFrom,
} from '@avsbhq/core';

isMultiContext(multiCtx); // type guard: narrows an EvalContext to MultiContext
getContextByKind(multiCtx, 'user'); // extract a SingleContext from a multi-context
userContext('u_123', { plan: 'pro' }); // shorthand for {kind:'user',key:'u_123',plan:'pro'}
bucketingKey(userCtx); // the key used for bucketing (kind-specific)
contextSummary(multiCtx); // [{kind,key}], for decision logging (no attributes)
privateAttributesFrom(userCtx); // attribute names the context marked private
```

---

## 5. Multi-context

`@avsbhq/core` defines the `MultiContext` type and the evaluator supports kinded targeting natively. A rule can target `organization.tier` while bucketing on `user.key`:

```ts
// Rule in the datafile:
// { hashAttribute: 'user.key', audienceIds: ['org-enterprise-audience'] }
//
// Audience condition:
// { contextKind: 'organization', attribute: 'tier', operator: 'equals', value: 'enterprise' }
```

The `resolveDottedAttribute` helper (exported for conformance tests) resolves a dotted path like `'user.plan'` against a multi-context:

```ts
import { resolveDottedAttribute } from '@avsbhq/core';

resolveDottedAttribute(multiCtx, 'user.plan'); // → 'pro'
resolveDottedAttribute(multiCtx, 'organization.tier'); // → 'enterprise'
```

---

## 6. Reading flags: `Flag<T>` shape

Every evaluation in the SDK ecosystem returns a `Flag<T>`:

```ts
export interface Flag<T = unknown> {
  readonly value: T; // the variation value
  readonly variationKey: string | null; // null if served the default
  readonly source: EvaluationSource;
  readonly ruleId: string | null;
  readonly ruleType: RuleType | null;
  readonly reasons: string[];
  readonly evaluatedAt: number; // ms epoch
  readonly durationMicros: number;
  isEnabled(): boolean; // source === 'rule' && value is truthy
  exists(): boolean; // source !== 'not_found'
}
```

`EvaluationSource` values:

```ts
type EvaluationSource =
  | 'datafileOverride' // override declared in dashboard
  | 'runtimeOverride' // set via setOverrideForUser / setGlobalOverride
  | 'sticky' // sticky bucketing assignment
  | 'rule' // matched a targeting or rollout rule
  | 'holdout' // user is in a holdout cohort
  | 'bandit' // bandit algorithm decision
  | 'default' // no rule matched; falling through to default
  | 'not_found' // flag key does not exist in the datafile
  | 'disabled'; // flag is disabled globally
```

Build `Flag<T>` objects in tests using the factory functions:

```ts
import { createFlag, notFoundFlag } from '@avsbhq/core';

const flag = createFlag<boolean>({
  value: true,
  variationKey: 'on',
  source: 'rule',
  ruleId: 'r_abc',
  ruleType: 'ab_test',
  reasons: ['matched audience: paid-users'],
});

const missing = notFoundFlag(false, 'flag key not in datafile');
```

---

## 7. Tracking events

`@avsbhq/core` defines the `TrackPayload` interface. Event submission is handled by the runtime SDKs (`@avsbhq/browser`, `@avsbhq/node`).

```ts
export interface TrackPayload {
  value?: number; // numeric metric quantity (revenue, count, etc.)
  properties?: Record<string, unknown>; // free-form analytics properties
  context?: EvalContext; // server SDK: required unless via forUser()
}
```

---

## 8. Error handling: `Logger`

`@avsbhq/core` exports the shared `Logger` interface and factory functions:

```ts
import { createLogger, noopLogger, consoleLogger, consoleTransport } from '@avsbhq/core';

// Logger interface:
interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
  child(prefix: string): Logger;
}

// Build a logger with multiple transports:
const logger = createLogger({
  level: 'warn',
  prefix: 'my-app',
  transports: [consoleTransport('warn')],
});
```

See `@avsbhq/utils` for pino and winston adapters.

---

## 9. SSR / hydration

Not applicable to `@avsbhq/core`. Hydration bootstrap logic lives in `@avsbhq/browser` (`serializeBootstrap` / `hydrateBootstrap`) and `@avsbhq/next` (`AvsbHydrator`, `AvsbServerProvider`).

---

## 10. Graceful shutdown

Not applicable to `@avsbhq/core`. Lifecycle management (polling, streaming, event flushing) lives in the runtime SDKs.

---

## 11. Testing: using `@avsbhq/core` in tests

When writing SDK port tests or testing code that handles `Flag<T>` objects, import the factory helpers directly:

```ts
import { createFlag, notFoundFlag, createEventBus } from '@avsbhq/core';
import { evaluateFlag } from '@avsbhq/core/engine';

// Build deterministic test flags
const FLAG_ENABLED = createFlag<boolean>({
  value: true,
  variationKey: 'on',
  source: 'rule',
  ruleId: 'r1',
  ruleType: 'ab_test',
  reasons: ['matched rule'],
});

// For application-level component and hook tests, use @avsbhq/test instead:
// import { createMockClient, TestData } from '@avsbhq/test'
// import { AvsbTestProvider } from '@avsbhq/test/react'
```

For application tests (components, hooks, route handlers), do not import `@avsbhq/core/engine` directly. Use `@avsbhq/test` mock utilities instead: they provide a stable, lifecycle-aware mock that does not depend on internal engine primitives.

---

## 12. Migration

There is no direct competitor to `@avsbhq/core` as a standalone pure-engine package. LaunchDarkly and Statsig embed their evaluation engines inside their runtime SDKs without a separately installable engine package. If you are migrating from either vendor and need to understand the shared types, the relevant comparison is:

| Concept            | LaunchDarkly         | Statsig         | `@avsbhq/core`         |
| ------------------ | -------------------- | --------------- | ---------------------- |
| Evaluation context | `LDContext`          | `StatsigUser`   | `EvalContext` (kinded) |
| Flag result        | `LDEvaluationDetail` | `DynamicConfig` | `Flag<T>`              |
| Event payload      | `LDCustomEventData`  | `LogEvent`      | `TrackPayload`         |
| Evaluation source  | `LDEvaluationReason` | inferred        | `EvaluationSource`     |

---

## Things to never call directly

Engine primitives (`evaluateFlag`, `evaluateAudience`, `murmurhash3`, `bucketContext`) live on the `@avsbhq/core/engine` subpath and are intentionally excluded from the default export.

Importing these directly in application code bypasses the tracker, the override system, sticky buckets, holdout logic, and the event bus. Only import from `/engine` when:

- You are implementing a per-language SDK port (Go, Python, Ruby, etc.)
- You are writing conformance tests against `@avsbhq/conformance`
- You are building a custom SDK layer

Do not import from `@avsbhq/core/engine` in application code or component tests. Use the runtime SDK (or `@avsbhq/test` for mocking) instead.

```ts
// Engine subpath: for SDK implementors only
import {
  evaluateFlag,
  evaluateAudience,
  murmurhash3,
  bucketContext, // traffic-allocation bucket
  assignmentBucket, // variation-assignment bucket
  holdoutBucket, // holdout classification bucket
  evaluateBandit,
  evaluateHoldout,
} from '@avsbhq/core/engine';
```

The three bucket helpers exist because the evaluator computes three
different hashes from three different input strings. Port authors should
read `packages/avsb-conformance/README.md` (the bucketing section) before
implementing them.
