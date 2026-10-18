// OpenFeature provider — `@avsbhq/utils/openfeature` subpath. Spec §6.8.
//
// Mirrors the OpenFeature server-sdk Provider interface using a duck-
// typed `ResolutionDetails` so consumers can pull the real
// @openfeature/server-sdk without forcing it as a runtime peer dep here.

import type {
  Flag,
  EvalContext,
  EvaluationSource,
  SingleContext,
  TrackPayload,
} from '@avsbhq/core';

export interface ResolutionDetails<T> {
  value: T;
  reason?: string;
  variant?: string;
  flagMetadata?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export interface OpenFeatureEvaluationContext {
  targetingKey?: string;
  [attribute: string]: unknown;
}

export interface ProviderMetadata {
  name: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic call-site preserved via runtime cast in adapter
type AnyFlag = Flag<any>;

/**
 * The slice of `AvsbServer` this provider needs. Context is the THIRD
 * POSITIONAL argument (breaking change B3): every server SDK in the family
 * now reads `getFlag(key, default, context)`, matching the edge client.
 */
export interface ServerEvaluator {
  getFlag(flagKey: string, defaultValue: unknown, context?: EvalContext): AnyFlag;
  /**
   * The TYPED getters, which is what each OpenFeature resolver has to call.
   *
   * `getFlag` alone skips the runtime type check, so `getBooleanValue()` on a
   * flag the platform declares as JSON used to hand OpenFeature the object,
   * typed as a boolean. The typed getters compare the resolved value against
   * the type declared in the datafile and fall back to the default when they
   * disagree, which is the behaviour the OpenFeature spec expects of a
   * provider.
   */
  getBoolFlag(flagKey: string, defaultValue: boolean, context?: EvalContext): Flag<boolean>;
  getStringFlag(flagKey: string, defaultValue: string, context?: EvalContext): Flag<string>;
  getNumberFlag(flagKey: string, defaultValue: number, context?: EvalContext): Flag<number>;
  getJsonFlag(flagKey: string, defaultValue: unknown, context?: EvalContext): AnyFlag;
  track(eventKey: string, payload: TrackPayload & { context: EvalContext }): void;
}

export interface BrowserEvaluator {
  getFlag(flagKey: string, defaultValue: unknown): AnyFlag;
  /** Typed getters, for the same reason the server interface declares them. */
  getBoolFlag(flagKey: string, defaultValue: boolean): Flag<boolean>;
  getStringFlag(flagKey: string, defaultValue: string): Flag<string>;
  getNumberFlag(flagKey: string, defaultValue: number): Flag<number>;
  getJsonFlag(flagKey: string, defaultValue: unknown): AnyFlag;
  /**
   * Rebind the identity flags are evaluated against.
   *
   * This used to read `setContext?(ctx)`, a method `AvsbClient` has never
   * had. Being optional, it type-checked against every real client and did
   * nothing, so `OpenFeature.setContext()` silently changed no bucketing at
   * all. `identify` is the real name (see `AvsbClient.identify`), and it is
   * required here so a client that cannot rebind fails to compile instead of
   * failing quietly.
   */
  identify(context: EvalContext): void;
  track(eventKey: string, payload?: TrackPayload): void;
}

export function ofContextToEvalContext(ctx: OpenFeatureEvaluationContext): EvalContext {
  const { targetingKey, ...rest } = ctx;
  const single: SingleContext = {
    kind: 'user',
    key: targetingKey ?? (typeof rest.key === 'string' ? rest.key : ''),
    ...rest,
  };
  return single;
}

/**
 * The two evaluation sources OpenFeature treats as errors rather than as
 * outcomes, mapped to its canonical error codes.
 *
 * `not_found` covers BOTH "that key is not in the datafile" and "the typed
 * getter refused a mistyped value", because the SDK returns the same
 * `notFoundFlag` for each and the only thing that distinguishes them is the
 * human-readable reason string, which is carried through as `errorMessage`.
 * Reporting `TYPE_MISMATCH` separately needs a machine-readable marker on
 * `Flag` that `@avsbhq/core` does not emit today; guessing from the message
 * text would be a silent downgrade the moment that wording changed.
 */
const OPENFEATURE_ERROR_CODES: Partial<Record<EvaluationSource, string>> = {
  not_found: 'FLAG_NOT_FOUND',
  not_ready: 'PROVIDER_NOT_READY',
};

function toResolution<T>(flag: Flag<T>): ResolutionDetails<T> {
  const flagMetadata = {
    ruleId: flag.ruleId,
    ruleType: flag.ruleType,
    durationMicros: flag.durationMicros,
  };
  const errorCode = OPENFEATURE_ERROR_CODES[flag.source];

  if (errorCode) {
    return {
      value: flag.value,
      variant: flag.variationKey ?? undefined,
      reason: 'ERROR',
      errorCode,
      errorMessage: flag.reasons[0] ?? flag.source,
      flagMetadata,
    };
  }

  return {
    value: flag.value,
    variant: flag.variationKey ?? undefined,
    reason: flag.source.toUpperCase(),
    flagMetadata,
  };
}

export class AvsbProvider {
  metadata: ProviderMetadata = { name: 'avsb' };
  private server: ServerEvaluator;

  constructor(server: ServerEvaluator) {
    this.server = server;
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    ctx: OpenFeatureEvaluationContext,
  ): ResolutionDetails<boolean> {
    return toResolution(
      this.server.getBoolFlag(flagKey, defaultValue, ofContextToEvalContext(ctx)),
    );
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    ctx: OpenFeatureEvaluationContext,
  ): ResolutionDetails<string> {
    return toResolution(
      this.server.getStringFlag(flagKey, defaultValue, ofContextToEvalContext(ctx)),
    );
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    ctx: OpenFeatureEvaluationContext,
  ): ResolutionDetails<number> {
    return toResolution(
      this.server.getNumberFlag(flagKey, defaultValue, ofContextToEvalContext(ctx)),
    );
  }

  resolveObjectEvaluation<T>(
    flagKey: string,
    defaultValue: T,
    ctx: OpenFeatureEvaluationContext,
  ): ResolutionDetails<T> {
    return toResolution(
      this.server.getJsonFlag(flagKey, defaultValue, ofContextToEvalContext(ctx)) as Flag<T>,
    );
  }

  /**
   * OpenFeature's `track(name, context, details)`.
   *
   * The context is REQUIRED on the way through: a server-side event with no
   * context has no visitor to attribute to. This used to forward `payload`
   * alone and drop the targeting key, so an OpenFeature-tracked conversion
   * either threw inside the server tracker or landed with an empty visitor id.
   */
  track(eventKey: string, ctx: OpenFeatureEvaluationContext, payload?: TrackPayload): void {
    this.server.track(eventKey, {
      ...payload,
      context: ofContextToEvalContext(ctx),
    });
  }
}

export class AvsbWebProvider {
  metadata: ProviderMetadata = { name: 'avsb-web' };
  private client: BrowserEvaluator;

  constructor(client: BrowserEvaluator) {
    this.client = client;
  }

  /**
   * OpenFeature's `setContext()` lands here. It rebinds the client's identity,
   * so every read after it evaluates, buckets and attributes against the new
   * context.
   *
   * It used to call `setContext?.()`, a method no A vs B client has ever had.
   * Optional-call syntax meant that compiled against every client and did
   * nothing at all: `OpenFeature.setContext({ targetingKey: 'u_2' })` returned
   * cleanly and left every subsequent evaluation on the OLD user.
   */
  onContextChange(_old: OpenFeatureEvaluationContext, next: OpenFeatureEvaluationContext): void {
    this.client.identify(ofContextToEvalContext(next));
  }

  resolveBooleanEvaluation(flagKey: string, defaultValue: boolean): ResolutionDetails<boolean> {
    return toResolution(this.client.getBoolFlag(flagKey, defaultValue));
  }

  resolveStringEvaluation(flagKey: string, defaultValue: string): ResolutionDetails<string> {
    return toResolution(this.client.getStringFlag(flagKey, defaultValue));
  }

  resolveNumberEvaluation(flagKey: string, defaultValue: number): ResolutionDetails<number> {
    return toResolution(this.client.getNumberFlag(flagKey, defaultValue));
  }

  resolveObjectEvaluation<T>(flagKey: string, defaultValue: T): ResolutionDetails<T> {
    return toResolution(this.client.getJsonFlag(flagKey, defaultValue) as Flag<T>);
  }
}
