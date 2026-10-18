// Sentry decision sink. Attaches a breadcrumb per decision so a future
// error report carries the flag-context that produced it.

import type { DecisionLogEntry } from '@avsbhq/core'
import type { DecisionSink } from '../decisions'

export interface SentryClient {
  addBreadcrumb(breadcrumb: {
    category: string
    message: string
    level?: 'info' | 'warning' | 'error' | 'debug'
    data?: Record<string, unknown>
    timestamp?: number
  }): void
}

export interface SentrySinkOptions {
  client: SentryClient
  /** Breadcrumb category. Default 'avsb.decision'. */
  category?: string
}

export function createSentrySink(opts: SentrySinkOptions): DecisionSink {
  const category = opts.category ?? 'avsb.decision'
  return {
    name: 'sentry',
    async write(batch) {
      for (const entry of batch) {
        opts.client.addBreadcrumb({
          category,
          message: `flag ${entry.flagKey} → ${entry.variationKey ?? 'default'}`,
          level: 'info',
          timestamp: Math.floor(entry.evaluatedAt / 1000),
          data: {
            source: entry.source,
            ruleId: entry.ruleId,
            ruleType: entry.ruleType,
            reasons: entry.reasons,
          },
        })
      }
    },
  }
}
