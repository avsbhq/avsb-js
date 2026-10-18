// Server surface barrel. '@avsbhq/next/server'.
//
// Import these from React Server Components, server actions, and layouts.
// Nothing here touches a browser API, and nothing here is a client
// component, so importing it from a server file is safe.

// The one-line setup.
export { AvsbRoot } from './AvsbRoot'
export type { AvsbRootProps } from './AvsbRoot'

// Datafile + evaluation.
export { getDatafile, DEFAULT_REVALIDATE_SECONDS } from './getDatafile'
export type { GetDatafileOptions } from './getDatafile'

export { evaluateFlagServer } from './evaluateFlagServer'
export { evaluateServerFlags, serializeFlag } from './serverFlags'

// The bootstrap blob, for apps that mount their provider somewhere the
// AvsbRoot subtree does not reach.
export { AvsbHydrator, serializeBootstrapBlob, AVSB_BOOTSTRAP_ID } from './AvsbHydrator'
export type { AvsbHydratorProps, AvsbBootstrapBlob } from './AvsbHydrator'

// The anonymous visitor cookie, shared with the middleware.
export {
  AVSB_ANON_COOKIE,
  AVSB_ANON_MAX_AGE_SECONDS,
  createAnonId,
  isAnonId,
  resolveAnonId,
  resolveAnonCookieOptions,
} from './anonCookie'
export type { AnonCookieOptions, ResolvedAnonCookie } from './anonCookie'

// Types a server file needs when it evaluates by hand.
export type { SerializedFlag, SerializedFlagMap } from '@avsbhq/react'
export type { EvalContext, Flag, FlagDatafile } from '@avsbhq/core'
