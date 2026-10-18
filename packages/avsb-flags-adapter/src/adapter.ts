/**
 * @avsbhq/flags-adapter: the A vs B adapter for the Flags SDK, and this package's
 * public entry point.
 *
 * ```ts
 * import { flag } from 'flags/next'
 * import { avsbAdapter } from '@avsbhq/flags-adapter'
 *
 * export const newCheckout = flag<boolean>({
 *   key: 'new-checkout-flow',
 *   adapter: avsbAdapter.booleanValue(),
 *   defaultValue: false,
 * })
 * ```
 *
 * One A vs B client per adapter, created on first use and reused for every
 * decision after that. `decide` is called once per flag per request by the
 * Flags SDK, which is exactly the moment a server-side decision is made, so
 * each one records an exposure by default (turn that off with
 * `exposure: 'off'` and record it yourself where the visitor sees it).
 *
 * Nothing here throws. A missing key, an unreachable CDN, or a visitor nobody
 * could identify all end the same way: the flag's declared default value, and
 * one log line naming what went wrong and where to fix it.
 */
import { DecideOption, consoleLogger } from '@avsbhq/core';
import type { Logger } from '@avsbhq/core';
import { resolveEvalContext } from './context';
import type {
  Adapter,
  AdapterDecideParams,
  AvsbClientFactory,
  AvsbEvaluator,
  EvalContext,
  ServerReadOptions,
} from './types';

export interface CreateAvsbAdapterOptions {
  /**
   * SDK key for the environment, shaped `sdk_<environment>_<id>`. Defaults to
   * `process.env.AVSB_SDK_KEY`.
   */
  sdkKey?: string;
  /** CDN base for datafile fetches. Default `https://cdn.avsb.cloud`. */
  cdnHost?: string;
  /**
   * Bring your own client (or a factory for one) when the app already runs an
   * `AvsbServer`, so the process holds one datafile and one event queue rather
   * than two.
   */
  client?: AvsbEvaluator | AvsbClientFactory;
  /**
   * Record an exposure for every decision. Default `'auto'`.
   *
   * `'off'` suppresses them, for flags you read early (middleware, layout) and
   * expose later with `manualExposure` where the visitor actually sees the
   * decision.
   */
  exposure?: 'auto' | 'off';
  /**
   * Cookie carrying the anonymous visitor id, used when a flag declares no
   * `identify`. Default `avsb_anon_id`, with the snippet's `_avsb_visitor` as
   * a second chance.
   */
  anonCookieName?: string;
  /** Where the Vercel Toolbar should link this flag. */
  origin?: string | ((flagKey: string) => string | undefined);
  /** Defaults to the console at warn level. */
  logger?: Logger;
}

export interface AvsbAdapter {
  booleanValue(): Adapter<boolean, EvalContext>;
  stringValue(): Adapter<string, EvalContext>;
  numberValue(): Adapter<number, EvalContext>;
  /**
   * A JSON flag. The fallback is required and is what a failed or unidentified
   * evaluation returns, because there is no sensible empty value for an
   * arbitrary shape.
   */
  jsonValue<T>(fallback: T): Adapter<T, EvalContext>;
  /**
   * The variation key rather than the value, for reporting which arm of an
   * experiment a request landed in. Null when nothing was decided.
   */
  variationKey(): Adapter<string | null, EvalContext>;
  /**
   * The underlying client, once it is ready. Null when it could not be
   * created; the reason was logged.
   */
  avsbClient(): Promise<AvsbEvaluator | null>;
  /** Flush queued events and stop polling. */
  close(): Promise<void>;
}

const MISSING_KEY =
  'no SDK key. Pass createAvsbAdapter({ sdkKey }) or set AVSB_SDK_KEY in the ' +
  'environment. The key for each environment is on app.avsb.cloud under ' +
  'Environments in the project sidebar, and looks like "sdk_production_ttqm0eaj4vth1krcb2xn".';

function isFactory(client: AvsbEvaluator | AvsbClientFactory): client is AvsbClientFactory {
  return typeof client === 'function';
}

async function createServerClient(options: CreateAvsbAdapterOptions): Promise<AvsbEvaluator> {
  const sdkKey = options.sdkKey ?? process.env['AVSB_SDK_KEY'] ?? '';
  if (sdkKey === '') throw new Error(MISSING_KEY);

  // Imported here rather than at the top so a bundle that only ever uses an
  // injected client never pulls the server SDK in.
  const { AvsbServer } = await import('@avsbhq/node');

  const client: AvsbEvaluator = new AvsbServer({
    sdkKey,
    ...(options.cdnHost !== undefined ? { cdnHost: options.cdnHost } : {}),
  });
  return client;
}

/**
 * Adapt A vs B to the Flags SDK.
 *
 * ```ts
 * import { flag } from 'flags/next'
 * import { avsbAdapter } from '@avsbhq/flags-adapter'
 *
 * export const newCheckout = flag<boolean>({
 *   key: 'new-checkout-flow',
 *   adapter: avsbAdapter.booleanValue(),
 *   defaultValue: false,
 * })
 * ```
 */
export function createAvsbAdapter(options: CreateAvsbAdapterOptions = {}): AvsbAdapter {
  const logger = options.logger ?? consoleLogger('warn');
  const warned = new Set<string>();

  const readOptions: ServerReadOptions =
    options.exposure === 'off' ? { decideOptions: [DecideOption.DISABLE_EXPOSURE] } : {};

  let clientPromise: Promise<AvsbEvaluator | null> | null = null;

  function ready(): Promise<AvsbEvaluator | null> {
    if (clientPromise === null) {
      clientPromise = (async (): Promise<AvsbEvaluator | null> => {
        const provided = options.client;
        const client =
          provided === undefined
            ? await createServerClient(options)
            : isFactory(provided)
              ? await provided()
              : provided;

        // `onReady()` never rejects: it resolves with the failure instead.
        const result = await client.onReady();
        if (!result.success) {
          logger.error(
            '[avsb] the Flags SDK adapter could not load a datafile, so every ' +
              `flag will return its default value. ${result.error?.message ?? ''}`.trim(),
          );
        }
        return client;
      })().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(
          `[avsb] the Flags SDK adapter has no client, so every flag returns its ` +
            `default value: ${message}`,
        );
        return null;
      });
    }
    return clientPromise;
  }

  type Read<ValueType> = (
    client: AvsbEvaluator,
    flagKey: string,
    defaultValue: ValueType,
    context: EvalContext,
  ) => ValueType;

  function build<ValueType>(
    emptyValue: ValueType,
    read: Read<ValueType>,
  ): Adapter<ValueType, EvalContext> {
    return {
      initialize: async (): Promise<void> => {
        await ready();
      },

      decide: async ({
        key,
        entities,
        cookies,
        defaultValue,
      }: AdapterDecideParams<ValueType, EvalContext>): Promise<ValueType> => {
        // `defaultValue` arrives as `unknown` because that is what the Flags SDK
        // declares (see AdapterDecideParams). The declaration's own generic is
        // what tells us it is a ValueType, and this adapter only ever reads it
        // as the fallback for a flag of that type, so the narrowing happens
        // here, once, at the boundary.
        const fallback = (defaultValue === undefined ? emptyValue : defaultValue) as ValueType;

        const context = resolveEvalContext({
          flagKey: key,
          entities,
          ...(cookies !== undefined ? { cookies } : {}),
          ...(options.anonCookieName !== undefined
            ? { anonCookieName: options.anonCookieName }
            : {}),
          logger,
          warned,
        });
        if (context === null) return fallback;

        const client = await ready();
        if (client === null) return fallback;

        return read(client, key, fallback, context);
      },

      ...(options.origin !== undefined ? { origin: options.origin } : {}),
    };
  }

  return {
    booleanValue: (): Adapter<boolean, EvalContext> =>
      build<boolean>(
        false,
        (client, key, defaultValue, context) =>
          client.getBoolFlag(key, defaultValue, context, readOptions).value,
      ),

    stringValue: (): Adapter<string, EvalContext> =>
      build<string>(
        '',
        (client, key, defaultValue, context) =>
          client.getStringFlag(key, defaultValue, context, readOptions).value,
      ),

    numberValue: (): Adapter<number, EvalContext> =>
      build<number>(
        0,
        (client, key, defaultValue, context) =>
          client.getNumberFlag(key, defaultValue, context, readOptions).value,
      ),

    jsonValue: <T>(fallback: T): Adapter<T, EvalContext> =>
      build<T>(
        fallback,
        (client, key, defaultValue, context) =>
          client.getJsonFlag<T>(key, defaultValue, context, readOptions).value,
      ),

    variationKey: (): Adapter<string | null, EvalContext> =>
      build<string | null>(null, (client, key, defaultValue, context) => {
        const flag = client.getFlag<unknown>(key, null, context, readOptions);
        return flag.variationKey ?? defaultValue;
      }),

    avsbClient: (): Promise<AvsbEvaluator | null> => ready(),

    close: async (): Promise<void> => {
      // Nothing was ever evaluated, so there is nothing to flush. Calling
      // ready() here would build a client (and hit the CDN) purely to close it,
      // which is the opposite of what a shutdown hook is for.
      if (clientPromise === null) return;

      const client = await clientPromise;
      if (client !== null) await client.close();
    },
  };
}

// ---------------------------------------------------------------------------
// The rest of the public surface.
//
// This file IS the package entry (see tsup.config.ts): the repo does not use
// barrel files, so the entry is the module that defines the thing it exports
// rather than a re-export shell.
// ---------------------------------------------------------------------------

export {
  DEFAULT_ANON_COOKIE,
  SNIPPET_VISITOR_COOKIE,
  isEvalContext,
  readSnippetVisitorId,
  resolveEvalContext,
} from './context';
export type { ResolveEvalContextInput } from './context';

export type {
  Adapter,
  AdapterDecideParams,
  AvsbClientFactory,
  AvsbEvaluator,
  CookieLike,
  CookiesLike,
  DecideOption,
  EvalContext,
  EvaluationSource,
  Flag,
  HeadersLike,
  InitResult,
  RuleType,
  ServerReadOptions,
} from './types';

/**
 * The adapter most apps use: it reads `AVSB_SDK_KEY` from the environment and
 * builds its client on the first decision, not at import time.
 *
 * Call `createAvsbAdapter({ … })` instead when you need a second environment,
 * a client you already own, or exposures turned off.
 */
export const avsbAdapter: AvsbAdapter = createAvsbAdapter();
