// Snowflake decision sink. Streams batches via a caller-supplied connection.
// Schema source of truth: snowflake.sql (same directory).
// Canonical column set: §8.9 of the SDK launch-readiness spec.

import type { DecisionLogEntry } from '@avsbhq/core'
import type { DecisionSink } from '../decisions'

/**
 * Canonical decision-log table shape (Snowflake DDL flavour).
 * See snowflake.sql for the authoritative CREATE TABLE statement.
 * This constant is kept for programmatic consumers that need to
 * provision the table at runtime without reading the .sql file.
 */
export const SNOWFLAKE_CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS {{table}} (
  decision_id     VARCHAR(36)    NOT NULL PRIMARY KEY,
  flag_key        VARCHAR(255)   NOT NULL,
  context_kind    VARCHAR(64)    NOT NULL,
  context_key     VARCHAR(255)   NOT NULL,
  variation_key   VARCHAR(255),
  value           VARIANT,
  source          VARCHAR(32)    NOT NULL,
  rule_id         VARCHAR(64),
  rule_type       VARCHAR(32),
  reasons         ARRAY,
  evaluated_at    TIMESTAMP_NTZ  NOT NULL,
  duration_micros NUMBER(10, 0),
  sdk_key         VARCHAR(255)   NOT NULL,
  sdk_version     VARCHAR(64)    NOT NULL
);`.trim()

export interface SnowflakeConnection {
  execute(opts: {
    sqlText: string
    binds?: unknown[][]
  }): Promise<{ rowCount: number }>
}

export interface SnowflakeSinkOptions {
  connection: SnowflakeConnection
  /** Fully-qualified table name. Required. */
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

// Column list matches bindRow order exactly.
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

export function createSnowflakeSink(opts: SnowflakeSinkOptions): DecisionSink {
  return {
    name: 'snowflake',
    async write(batch) {
      if (batch.length === 0) return
      // Snowflake multi-row VALUES bind: each row is an array of bind values.
      // PARSE_JSON wraps the two JSON-encoded columns (value, reasons).
      const rowPlaceholder = `(?, ?, ?, ?, ?, PARSE_JSON(?), ?, ?, ?, PARSE_JSON(?), ?, ?, ?, ?)`
      const valueSets = batch.map(() => rowPlaceholder).join(', ')
      const sql =
        `INSERT INTO ${opts.table} (${COLS.join(', ')}) ` +
        `SELECT column1, column2, column3, column4, column5, column6, ` +
        `column7, column8, column9, column10, column11, column12, column13, column14 ` +
        `FROM VALUES ${valueSets}`
      const binds = batch.map((e) => bindRow(e, opts.sdkKey, opts.sdkVersion))
      await opts.connection.execute({ sqlText: sql, binds })
    },
  }
}
