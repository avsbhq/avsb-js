import type { JSX } from 'solid-js'
import type { AvsbClientOptions } from '@avsbhq/browser'
import type { SolidAvsbClient } from './clientInterface'

// -----------------------------------------------------------------------
// Provider status.
// -----------------------------------------------------------------------

/**
 * - `'loading'`: no datafile yet and nothing cached.
 * - `'ready'`: flags answer. Also the state of a DEGRADED client (serving a
 *   cached datafile after a failed refresh): values work, they may be stale,
 *   and `error` says why.
 * - `'error'`: nothing could be loaded. Every flag returns the default you
 *   passed, and `error.message` names the status, the URL, and the fix.
 */
export type AvsbStatus = 'loading' | 'ready' | 'error'

/** The status snapshot, as one value. */
export interface AvsbStatusValue {
  status: AvsbStatus
  error: Error | undefined
  degraded: boolean
}

// -----------------------------------------------------------------------
// Provider props: Mode A (the provider owns the client) or Mode B (you do).
// -----------------------------------------------------------------------

export type AvsbProviderProps =
  | (AvsbClientOptions & { children: JSX.Element; client?: never })
  | { client: SolidAvsbClient; children: JSX.Element }

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
