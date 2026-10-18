import type { AvsbClientOptions } from '@avsbhq/browser'
import type { EvalContext, FlagDatafile } from '@avsbhq/core'
import type { VueAvsbClient } from './clientInterface'

// -----------------------------------------------------------------------
// Provider status.
// -----------------------------------------------------------------------

/**
 * - `'loading'`: the first datafile has not arrived and nothing is cached.
 * - `'ready'`: flags are readable. Also the state of a DEGRADED client
 *   (serving a cached datafile after a failed refresh): flags work, they
 *   may be stale, and `error` says why.
 * - `'error'`: nothing could be loaded. Every flag returns the default you
 *   pass, and `error.message` names the status, the URL, and the fix.
 */
export type AvsbStatus = 'loading' | 'ready' | 'error'

// -----------------------------------------------------------------------
// Provider props: Mode A (the provider owns the client) or Mode B (you do).
// -----------------------------------------------------------------------

/** Every `AvsbClientOptions` field except the ones with their own prop. */
export type AvsbProviderOptions = Omit<
  AvsbClientOptions,
  'sdkKey' | 'context' | 'bootstrap'
>

export interface AvsbProviderModeAProps {
  /** SDK key for the environment you are targeting. Required in Mode A. */
  sdkKey: string
  /** Evaluation context. Omit for an anonymous, persisted visitor id. */
  context?: EvalContext
  /** A datafile fetched on the server, so the first paint has real values. */
  bootstrap?: FlagDatafile
  /** Everything else `AvsbClient` accepts (polling, logging, caching). */
  options?: AvsbProviderOptions
  client?: never
}

export interface AvsbProviderModeBProps {
  /** A client you built and own. The provider will not close it. */
  client: VueAvsbClient
  sdkKey?: never
}

export type AvsbProviderProps = AvsbProviderModeAProps | AvsbProviderModeBProps

// -----------------------------------------------------------------------
// Re-exports so consumers need one import path.
// -----------------------------------------------------------------------

export type { AvsbClientOptions } from '@avsbhq/browser'

export type {
  Flag,
  EvalContext,
  SingleContext,
  MultiContext,
  TrackPayload,
  InitResult,
  ClientEventMap,
  ClientEventName,
  EvaluationSource,
  FlagDatafile,
  FlagDatafileEntry,
  FlagDatafileVariation,
  FlagDatafileOverride,
  FlagDatafileRule,
  FlagDatafileAudience,
  Logger,
  DecideOption,
} from '@avsbhq/core'
