// What AvsbClient keeps across page loads and identities: the bootstrap or
// cached datafile served on the constructor's tick, and the persisted
// visitor identity behind updateAttributes and reset. Split out of
// AvsbClient.ts (FU-31).

import type { AvsbClientOptions } from './types'
import type { SingleContext } from '@avsbhq/core'
import { isMultiContext, getContextByKind } from '@avsbhq/core'
import { anonymousContext, generateAnonId, rotateVisitorId } from './identity'
import { readCachedDatafile } from './datafileCache'
import { acceptDatafile } from './datafileGuard'
import type { ClientState } from './clientState'
import { diffAndEmitChanges } from './clientEvents'
import { adoptDatafile } from './clientDatafile'
import { ensureTracker } from './clientTracking'

/**
 * Serve a bootstrap or cached datafile on the constructor's own tick, so
 * flags are readable before the network load starts.
 */
export function serveInitialDatafile(s: ClientState, options: AvsbClientOptions): void {
  // A malformed bootstrap is refused with a logged reason (N0-15) and the
  // client falls through to its cache and the CDN, as if none was passed.
  const bootstrap = options.bootstrap
    ? acceptDatafile(options.bootstrap, 'bootstrap', s.logger)
    : null
  if (bootstrap) {
    adoptDatafile(s, bootstrap, 'bootstrap')
    // The tracker is built HERE, on the same tick as the cache branch below,
    // because `adoptDatafile` makes flags readable immediately while
    // `computeFlag` only records an exposure when a tracker exists. Leaving it
    // to `initialize()` (one microtask later) meant a bootstrapped client
    // served correct decisions and silently dropped every exposure produced in
    // the tick it was constructed: `isReady()` said yes, and the events were
    // gone. Idempotent, so the later call in `initialize()` is a no-op.
    ensureTracker(s)
  } else if (s.cacheEnabled) {
    // Cache-then-network: flags are readable on this tick, and the
    // network refresh runs behind them.
    const cached = readCachedDatafile(s.sdkKey, {
      maxAgeMs: s.cacheMaxAgeMs,
      logger: s.logger,
    })
    if (cached) {
      s.datafileEtag = cached.etag
      adoptDatafile(s, cached.datafile, 'cache')
      ensureTracker(s)
      s.logger.debug('served the cached datafile while refreshing', {
        ageMs: cached.ageMs,
      })
    }
  }
}

/** The body of `AvsbClient.updateAttributes`. */
export function mergeAttributes(
  s: ClientState,
  partial: Record<string, unknown>,
  contextKind: string = 'user'
): void {
  if (isMultiContext(s.context)) {
    const existing = getContextByKind(s.context, contextKind)
    if (existing) {
      const updated: SingleContext = { ...existing, ...partial }
      s.context = {
        ...s.context,
        [contextKind]: updated,
      }
    } else {
      // Kind not present — add it as a new sub-context.
      s.context = {
        ...s.context,
        [contextKind]: newSubContext(contextKind, partial),
      }
    }
  } else {
    // Single context: only merge when kind matches.
    const single = s.context as SingleContext
    if (single.kind === contextKind) {
      s.context = { ...single, ...partial }
    } else {
      // Different kind than the current single context — upgrade to multi.
      s.context = {
        kind: 'multi',
        [single.kind]: single,
        [contextKind]: newSubContext(contextKind, partial),
      }
    }
  }
  diffAndEmitChanges(s)
}

function newSubContext(
  contextKind: string,
  partial: Record<string, unknown>,
): SingleContext {
  return {
    kind: contextKind,
    key: String(partial['key'] ?? generateAnonId()),
    ...partial,
  }
}

/** The body of `AvsbClient.reset`. */
export function resetIdentity(s: ClientState): void {
  s.anonymousId = rotateVisitorId(s.logger)
  s.context = anonymousContext(s.anonymousId)
  s.overrides.clearAll()
  diffAndEmitChanges(s)
}
