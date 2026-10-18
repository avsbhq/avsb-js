// Redshift decision sink. Uses the pg-wire parameterised INSERT pattern.
// Schema source of truth: redshift.sql (same directory).
// Canonical column set: §8.9 of the SDK launch-readiness spec.

import type { DecisionLogEntry } from '@avsbhq/core'
import type { DecisionSink } from '../decisions'

export interface RedshiftClient {
  query(opts: {
    text: string
    values: unknown[]
  }): Promise<{ rowCount: number }>
}

export interface RedshiftSinkOptions {
  client: RedshiftClient
  /** Fully-qualified table name. */
  table: string
  /** SDK key for the environment writing these decisions. */
  sdkKey: string
  /** SDK version string (e.g. "1.2.3"). */
  sdkVersion: string
}

// Column list — order matches bindRow exactly.
const COLS = [
  'decision_id',
  'flag_key',
  'context_kind',
  'context_key',
  'variation_key',
  'value',
  'source',
  'rule_id',
  'rule_type',
  'reasons',
  'evaluated_at',
  'duration_micros',
  'sdk_key',
  'sdk_version',
] as const

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
): unknown[] {
  const ctx = primaryContext(e.contextSummary)
  return [
    crypto.randomUUID(),
    e.flagKey,
    ctx.kind,
    ctx.key,
    e.variationKey ?? null,
    JSON.stringify(e.value),
    e.source,
    e.ruleId ?? null,
    e.ruleType ?? null,
    JSON.stringify(e.reasons),
    new Date(e.evaluatedAt).toISOString(),
    e.durationMicros ?? null,
    sdkKey,
    sdkVersion,
  ]
}

export function createRedshiftSink(opts: RedshiftSinkOptions): DecisionSink {
  return {
    name: 'redshift',
    async write(batch) {
      if (batch.length === 0) return
      const placeholders: string[] = []
      const values: unknown[] = []
      let idx = 1
      for (const e of batch) {
        const row = bindRow(e, opts.sdkKey, opts.sdkVersion)
        const ph = row.map(() => `$${idx++}`).join(', ')
        placeholders.push(`(${ph})`)
        values.push(...row)
      }
      const sql = `INSERT INTO ${opts.table} (${COLS.join(', ')}) VALUES ${placeholders.join(', ')}`
      await opts.client.query({ text: sql, values })
    },
  }
}
