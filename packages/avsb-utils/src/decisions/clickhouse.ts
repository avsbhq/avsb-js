// ClickHouse decision sink. Uses the JSONEachRow ingest path on a
// caller-supplied client.
// Schema source of truth: clickhouse.sql (same directory).
// Canonical column set: §8.9 of the SDK launch-readiness spec.

import type { DecisionLogEntry } from '@avsbhq/core'
import type { DecisionSink } from '../decisions'

export interface ClickHouseClient {
  insert(opts: {
    table: string
    values: Array<Record<string, unknown>>
    format: 'JSONEachRow' | string
  }): Promise<unknown>
}

export interface ClickHouseSinkOptions {
  client: ClickHouseClient
  /** Table name. */
  table: string
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
    // ClickHouse stores value as JSON-encoded String per clickhouse.sql.
    value: JSON.stringify(e.value),
    source: e.source,
    rule_id: e.ruleId ?? null,
    rule_type: e.ruleType ?? null,
    reasons: e.reasons,
    evaluated_at: new Date(e.evaluatedAt).toISOString(),
    duration_micros: e.durationMicros ?? 0,
    sdk_key: sdkKey,
    sdk_version: sdkVersion,
  }
}

export function createClickHouseSink(
  opts: ClickHouseSinkOptions
): DecisionSink {
  return {
    name: 'clickhouse',
    async write(batch) {
      if (batch.length === 0) return
      await opts.client.insert({
        table: opts.table,
        format: 'JSONEachRow',
        values: batch.map((e) => bindRow(e, opts.sdkKey, opts.sdkVersion)),
      })
    },
  }
}
