// BigQuery decision sink. Uses the streaming-insert API via a caller-
// supplied table reference.
// Schema source of truth: bigquery.sql (same directory).
// Canonical column set: §8.9 of the SDK launch-readiness spec.

import type { DecisionLogEntry } from '@avsbhq/core'
import type { DecisionSink } from '../decisions'

export interface BigQueryTable {
  insert(
    rows: Array<{ insertId?: string; json: Record<string, unknown> }>
  ): Promise<unknown>
}

export interface BigQuerySinkOptions {
  /** GCP project id. */
  project: string
  /** BigQuery dataset id. */
  dataset: string
  /** Table id. */
  table: string
  /** Table API surface. Caller-supplied to keep @google-cloud/bigquery a peer dep. */
  client: BigQueryTable
  /** SDK key for the environment writing these decisions. */
  sdkKey: string
  /** SDK version string (e.g. "1.2.3"). */
  sdkVersion: string
}

/** Derive the primary context kind + key from contextSummary. */
function primaryContext(summary: DecisionLogEntry['contextSummary']): {
  kind: string
  key: string
} {
  if (summary.length === 0) {
    return { kind: 'unknown', key: '' }
  }
  if (summary.length === 1) {
    return { kind: summary[0].kind, key: summary[0].key }
  }
  // Multi-context: kind='multi', key = all keys joined
  return {
    kind: 'multi',
    key: summary.map((c) => c.key).join(','),
  }
}

export function bindRow(
  e: DecisionLogEntry,
  sdkKey: string,
  sdkVersion: string
): Record<string, unknown> {
  const ctx = primaryContext(e.contextSummary)
  return {
    decision_id: crypto.randomUUID(),
    flag_key: e.flagKey,
    context_kind: ctx.kind,
    context_key: ctx.key,
    variation_key: e.variationKey ?? null,
    value: JSON.stringify(e.value),
    source: e.source,
    rule_id: e.ruleId ?? null,
    rule_type: e.ruleType ?? null,
    reasons: e.reasons,
    evaluated_at: new Date(e.evaluatedAt).toISOString(),
    duration_micros: e.durationMicros ?? null,
    sdk_key: sdkKey,
    sdk_version: sdkVersion,
  }
}

export function createBigQuerySink(opts: BigQuerySinkOptions): DecisionSink {
  return {
    name: 'bigquery',
    async write(batch) {
      if (batch.length === 0) return
      const rows = batch.map((e) => ({
        // insertId provides at-least-once deduplication in BQ streaming.
        insertId: `${e.flagKey}:${e.evaluatedAt}:${crypto.randomUUID()}`,
        json: bindRow(e, opts.sdkKey, opts.sdkVersion),
      }))
      await opts.client.insert(rows)
    },
  }
}
