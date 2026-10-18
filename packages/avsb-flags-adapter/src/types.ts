/**
 * The two contracts this package sits between.
 *
 * 1. The Flags SDK's `Adapter`, mirrored here structurally instead of imported.
 *    That is deliberate: this adapter has no runtime dependency on `flags`, so
 *    it builds, tests and typechecks without it, and a `flags` major that
 *    widens its own types cannot break the build of a package that never
 *    imports them. The shapes below are written to be ACCEPTING (parameters
 *    are supersets of what the Flags SDK passes, return types are subsets of
 *    what it allows), which is what structural typing needs for
 *    `flag({ adapter: avsbAdapter.booleanValue() })` to check.
 *
 * 2. The slice of `@avsbhq/node` the adapter evaluates through. `AvsbServer`
 *    satisfies it, and `src/adapter.ts` proves that at build time where it
 *    constructs one.
 */
import type {
  DecideOption,
  EvalContext,
  EvaluationSource,
  Flag,
  InitResult,
  RuleType,
} from '@avsbhq/core';

// ---------------------------------------------------------------------------
// 1. The Flags SDK side
// ---------------------------------------------------------------------------

/** What the Flags SDK hands over for reading request headers. */
export interface HeadersLike {
  get(name: string): string | null;
}

/** One cookie, as Next's cookie store returns it. */
export interface CookieLike {
  value: string;
}

/** What the Flags SDK hands over for reading request cookies. */
export interface CookiesLike {
  get(name: string): CookieLike | undefined;
}

export interface AdapterDecideParams<ValueType, EntitiesType> {
  /** The flag key, taken from the `flag({ key })` declaration. */
  key: string;
  /** Whatever the declaration's `identify` returned. */
  entities?: EntitiesType;
  headers?: HeadersLike;
  cookies?: CookiesLike;
  /**
   * The declaration's `defaultValue`, when it set one.
   *
   * `unknown`, not `ValueType`, because that is what the Flags SDK declares
   * (`Adapter.decide` in flags 4.x) and `decide` is a function-typed PROPERTY:
   * under `strictFunctionTypes` its parameter object is checked
   * contravariantly, so narrowing this field here made every adapter we build
   * unassignable to the SDK's `Adapter` and the package's own quickstart stopped
   * compiling. Narrow it at the point of use if a decide implementation needs
   * the value.
   */
  defaultValue?: unknown;
}

/**
 * The Flags SDK adapter shape: `decide` is required, the rest is optional.
 *
 * `origin` is what the Vercel Toolbar links to for this flag. Only a string or
 * a function returning one is produced here, both of which the Flags SDK
 * accepts.
 */
export interface Adapter<ValueType, EntitiesType> {
  decide: (params: AdapterDecideParams<ValueType, EntitiesType>) => Promise<ValueType>;
  initialize?: () => Promise<void>;
  origin?: string | ((flagKey: string) => string | undefined);
}

// ---------------------------------------------------------------------------
// 2. The A vs B side
// ---------------------------------------------------------------------------

/** Per-evaluation options, the subset this adapter passes through. */
export interface ServerReadOptions {
  decideOptions?: DecideOption[];
}

/**
 * The slice of `AvsbServer` from `@avsbhq/node` the adapter uses. Context is
 * the third positional argument on every read, which is the server contract
 * across the whole SDK family.
 */
export interface AvsbEvaluator {
  onReady(): Promise<InitResult>;
  getBoolFlag(
    flagKey: string,
    defaultValue: boolean,
    context?: EvalContext,
    options?: ServerReadOptions,
  ): Flag<boolean>;
  getStringFlag(
    flagKey: string,
    defaultValue: string,
    context?: EvalContext,
    options?: ServerReadOptions,
  ): Flag<string>;
  getNumberFlag(
    flagKey: string,
    defaultValue: number,
    context?: EvalContext,
    options?: ServerReadOptions,
  ): Flag<number>;
  getJsonFlag<T>(
    flagKey: string,
    defaultValue: T,
    context?: EvalContext,
    options?: ServerReadOptions,
  ): Flag<T>;
  getFlag<T>(
    flagKey: string,
    defaultValue: T,
    context?: EvalContext,
    options?: ServerReadOptions,
  ): Flag<T>;
  close(): Promise<void>;
}

/** Build (or hand over) the client the adapter evaluates through. */
export type AvsbClientFactory = () => AvsbEvaluator | Promise<AvsbEvaluator>;

// `Flag` is re-exported here, and its own members have names: `source` is an
// `EvaluationSource`, `ruleType` is a `RuleType`. Without these a consumer can
// hold the value but cannot annotate its parts from this package.
export type { EvalContext, Flag, RuleType, EvaluationSource, InitResult, DecideOption };
