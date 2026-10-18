// =====================================================================
// Backoff for the browser client: the tracker's retry loop and the polling
// loop's jitter.
//
// The curve itself now lives ONCE, in `@avsbhq/utils/backoff`, and this file
// re-exports it. It used to be a byte-for-byte copy of the node package's
// module, with a third copy inlined in the utils streaming client: three
// chances for a fleet-wide thundering herd to come back in one runtime after
// being fixed in another.
//
// `@avsbhq/utils/backoff` is a zero-dependency leaf subpath, so importing it
// does not pull the utils root chunk into a browser bundle.
// =====================================================================

export {
  nextBackoff,
  resetBackoff,
  parseRetryAfter,
  jitteredInterval,
  BACKOFF_DEFAULTS,
} from '@avsbhq/utils/backoff'
export type { BackoffState } from '@avsbhq/utils/backoff'
