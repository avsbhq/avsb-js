import { describe, expect, it, vi } from 'vitest'
import type { DecisionLogEntry } from '@avsbhq/core'
import { createDecisionRecorder } from './decisions'
import { createOtelSink } from './decisions/otel'
import { createSentrySink } from './decisions/sentry'
import { createDatadogSink } from './decisions/datadog'
import {
  createSnowflakeSink,
  bindRow as snowflakeBindRow,
  SNOWFLAKE_CREATE_TABLE,
} from './decisions/snowflake'
import {
  createRedshiftSink,
  bindRow as redshiftBindRow,
} from './decisions/redshift'
import {
  createClickHouseSink,
  bindRow as clickhouseBindRow,
} from './decisions/clickhouse'
import {
  createBigQuerySink,
  bindRow as bigqueryBindRow,
} from './decisions/bigquery'

// UUID v4 pattern
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function makeEntry(overrides: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
  return {
    flagKey: 'flagA',
    value: { plan: 'pro', email: 'a@b.com' },
    variationKey: 'on',
    source: 'rule',
    ruleId: 'r1',
    ruleType: 'ab_test',
    reasons: ['email=a@b.com matched'],
    evaluatedAt: 1700000000000,
    durationMicros: 12,
    contextSummary: [{ kind: 'user', key: 'u_1' }],
    ...overrides,
  }
}

describe('createDecisionRecorder', () => {
  it('forwards entries to every sink on flush', async () => {
    const sink = { name: 's1', write: vi.fn(async () => undefined) }
    const rec = createDecisionRecorder({
      sinks: [sink],
      flushInterval: 0,
    })
    rec.record(makeEntry())
    await rec.flush()
    expect(sink.write).toHaveBeenCalledOnce()
    expect(sink.write).toHaveBeenCalledWith([expect.objectContaining({ flagKey: 'flagA' })])
  })

  it('redacts declared private attributes from value + reasons', async () => {
    const sink = { name: 's', write: vi.fn(async () => undefined) }
    const rec = createDecisionRecorder({
      sinks: [sink],
      privateAttributes: ['email'],
    })
    rec.record(makeEntry())
    await rec.flush()
    const calls = sink.write.mock.calls as unknown as Array<[DecisionLogEntry[]]>
    const forwarded = calls[0][0][0]
    expect((forwarded.value as { email: string }).email).toBe('[REDACTED]')
    expect(forwarded.reasons[0]).toContain('[REDACTED]')
  })

  it('drops entries when sampling excludes them', async () => {
    const sink = { name: 's', write: vi.fn(async () => undefined) }
    const rec = createDecisionRecorder({ sinks: [sink], sample: 0 })
    for (let i = 0; i < 100; i++) rec.record(makeEntry())
    await rec.flush()
    expect(sink.write).not.toHaveBeenCalled()
  })

  it('reports sink errors via onSinkError', async () => {
    const onSinkError = vi.fn()
    const rec = createDecisionRecorder({
      sinks: [
        {
          name: 's',
          write: async () => {
            throw new Error('boom')
          },
        },
      ],
      onSinkError,
    })
    rec.record(makeEntry())
    await rec.flush()
    expect(onSinkError).toHaveBeenCalledWith('s', expect.any(Error))
  })

  it('close() flushes pending entries and clears the timer', async () => {
    const sink = { name: 's', write: vi.fn(async () => undefined) }
    const rec = createDecisionRecorder({ sinks: [sink], flushInterval: 0 })
    rec.record(makeEntry())
    await rec.close()
    expect(sink.write).toHaveBeenCalled()
  })
})

describe('warehouse + observability sinks (smoke)', () => {
  const entry = makeEntry()

  it('createOtelSink emits one attribute set per entry', async () => {
    const exporter = { export: vi.fn(async () => undefined) }
    await createOtelSink({ exporter }).write([entry])
    expect(exporter.export).toHaveBeenCalledOnce()
    const calls = exporter.export.mock.calls as unknown as Array<[
      Array<{ attributes: Record<string, unknown> }>,
    ]>
    const spans = calls[0][0]
    expect(spans[0].attributes['avsb.flag.key']).toBe('flagA')
  })

  it('createSentrySink adds one breadcrumb per entry', async () => {
    const client = { addBreadcrumb: vi.fn() }
    await createSentrySink({ client }).write([entry, entry])
    expect(client.addBreadcrumb).toHaveBeenCalledTimes(2)
  })

  it('createDatadogSink POSTs the batch and throws on non-ok', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200 }) as Response)
    await createDatadogSink({ apiKey: 'k', fetchImpl: f }).write([entry])
    expect(f).toHaveBeenCalled()

    const fBad = vi.fn(async () => ({ ok: false, status: 500 }) as Response)
    await expect(
      createDatadogSink({ apiKey: 'k', fetchImpl: fBad }).write([entry])
    ).rejects.toThrow(/Datadog/)
  })

  it('SNOWFLAKE_CREATE_TABLE exposes the canonical schema template', () => {
    expect(SNOWFLAKE_CREATE_TABLE).toContain('flag_key')
    expect(SNOWFLAKE_CREATE_TABLE).toContain('variation_key')
  })

  it('createSnowflakeSink invokes connection.execute with binds', async () => {
    const connection = { execute: vi.fn(async () => ({ rowCount: 1 })) }
    await createSnowflakeSink({
      connection,
      table: 't',
      sdkKey: 'sdk-key-1',
      sdkVersion: '1.0.0',
    }).write([entry])
    expect(connection.execute).toHaveBeenCalled()
  })

  it('createBigQuerySink calls table.insert with rows', async () => {
    const client = { insert: vi.fn(async () => undefined) }
    await createBigQuerySink({
      project: 'p',
      dataset: 'd',
      table: 't',
      client,
      sdkKey: 'sdk-key-1',
      sdkVersion: '1.0.0',
    }).write([entry])
    expect(client.insert).toHaveBeenCalled()
  })

  it('createRedshiftSink emits one parameterised insert per batch', async () => {
    const client = { query: vi.fn(async () => ({ rowCount: 1 })) }
    await createRedshiftSink({
      client,
      table: 't',
      sdkKey: 'sdk-key-1',
      sdkVersion: '1.0.0',
    }).write([entry, entry])
    expect(client.query).toHaveBeenCalledOnce()
  })

  it('createClickHouseSink uses JSONEachRow format', async () => {
    const client = { insert: vi.fn(async () => undefined) }
    await createClickHouseSink({
      client,
      table: 't',
      sdkKey: 'sdk-key-1',
      sdkVersion: '1.0.0',
    }).write([entry])
    const calls = client.insert.mock.calls as unknown as Array<[{ format: string }]>
    expect(calls[0][0].format).toBe('JSONEachRow')
  })
})

// ---------------------------------------------------------------------------
// Snowflake bindRow — canonical column tests
// ---------------------------------------------------------------------------

describe('Snowflake bindRow', () => {
  const entry = makeEntry()
  const SDK_KEY = 'sf-sdk-key'
  const SDK_VERSION = '2.1.0'

  it('produces all 14 canonical columns in correct order', () => {
    const row = snowflakeBindRow(entry, SDK_KEY, SDK_VERSION)
    // 14 columns: decision_id, flag_key, context_kind, context_key,
    // variation_key, value, source, rule_id, rule_type, reasons,
    // evaluated_at, duration_micros, sdk_key, sdk_version
    expect(row).toHaveLength(14)
  })

  it('decision_id is a valid UUID v4', () => {
    const row = snowflakeBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row[0]).toMatch(UUID_RE)
  })

  it('derives context_kind and context_key from single-context contextSummary', () => {
    const row = snowflakeBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row[2]).toBe('user')   // context_kind
    expect(row[3]).toBe('u_1')    // context_key
  })

  it('derives kind=multi and joined keys from multi-context contextSummary', () => {
    const multiEntry = makeEntry({
      contextSummary: [
        { kind: 'user', key: 'u_1' },
        { kind: 'org', key: 'org_42' },
      ],
    })
    const row = snowflakeBindRow(multiEntry, SDK_KEY, SDK_VERSION)
    expect(row[2]).toBe('multi')
    expect(row[3]).toBe('u_1,org_42')
  })

  it('sdk_key and sdk_version flow through to correct positions', () => {
    const row = snowflakeBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row[12]).toBe(SDK_KEY)
    expect(row[13]).toBe(SDK_VERSION)
  })

  it('each invocation produces a unique decision_id', () => {
    const id1 = snowflakeBindRow(entry, SDK_KEY, SDK_VERSION)[0]
    const id2 = snowflakeBindRow(entry, SDK_KEY, SDK_VERSION)[0]
    expect(id1).not.toBe(id2)
  })
})

// ---------------------------------------------------------------------------
// BigQuery bindRow — canonical column tests
// ---------------------------------------------------------------------------

describe('BigQuery bindRow', () => {
  const entry = makeEntry()
  const SDK_KEY = 'bq-sdk-key'
  const SDK_VERSION = '2.1.0'

  it('produces all 14 canonical column keys', () => {
    const row = bigqueryBindRow(entry, SDK_KEY, SDK_VERSION)
    const expected = [
      'decision_id', 'flag_key', 'context_kind', 'context_key',
      'variation_key', 'value', 'source', 'rule_id', 'rule_type',
      'reasons', 'evaluated_at', 'duration_micros', 'sdk_key', 'sdk_version',
    ]
    for (const col of expected) {
      expect(row).toHaveProperty(col)
    }
  })

  it('decision_id is a valid UUID v4', () => {
    const row = bigqueryBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row['decision_id']).toMatch(UUID_RE)
  })

  it('derives context_kind and context_key from single contextSummary', () => {
    const row = bigqueryBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row['context_kind']).toBe('user')
    expect(row['context_key']).toBe('u_1')
  })

  it('derives kind=multi and joined keys from multi-context contextSummary', () => {
    const multiEntry = makeEntry({
      contextSummary: [
        { kind: 'device', key: 'd_1' },
        { kind: 'account', key: 'a_99' },
      ],
    })
    const row = bigqueryBindRow(multiEntry, SDK_KEY, SDK_VERSION)
    expect(row['context_kind']).toBe('multi')
    expect(row['context_key']).toBe('d_1,a_99')
  })

  it('sdk_key and sdk_version flow through correctly', () => {
    const row = bigqueryBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row['sdk_key']).toBe(SDK_KEY)
    expect(row['sdk_version']).toBe(SDK_VERSION)
  })

  it('each invocation produces a unique decision_id', () => {
    const id1 = bigqueryBindRow(entry, SDK_KEY, SDK_VERSION)['decision_id']
    const id2 = bigqueryBindRow(entry, SDK_KEY, SDK_VERSION)['decision_id']
    expect(id1).not.toBe(id2)
  })
})

// ---------------------------------------------------------------------------
// Redshift bindRow — canonical column tests
// ---------------------------------------------------------------------------

describe('Redshift bindRow', () => {
  const entry = makeEntry()
  const SDK_KEY = 'rs-sdk-key'
  const SDK_VERSION = '2.1.0'

  it('produces all 14 canonical columns in correct order', () => {
    const row = redshiftBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row).toHaveLength(14)
  })

  it('decision_id is a valid UUID v4', () => {
    const row = redshiftBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row[0]).toMatch(UUID_RE)
  })

  it('derives context_kind and context_key from single contextSummary', () => {
    const row = redshiftBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row[2]).toBe('user')
    expect(row[3]).toBe('u_1')
  })

  it('derives kind=multi and joined keys from multi-context contextSummary', () => {
    const multiEntry = makeEntry({
      contextSummary: [
        { kind: 'user', key: 'u_1' },
        { kind: 'company', key: 'c_7' },
      ],
    })
    const row = redshiftBindRow(multiEntry, SDK_KEY, SDK_VERSION)
    expect(row[2]).toBe('multi')
    expect(row[3]).toBe('u_1,c_7')
  })

  it('sdk_key and sdk_version flow through to correct positions', () => {
    const row = redshiftBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row[12]).toBe(SDK_KEY)
    expect(row[13]).toBe(SDK_VERSION)
  })

  it('each invocation produces a unique decision_id', () => {
    const id1 = redshiftBindRow(entry, SDK_KEY, SDK_VERSION)[0]
    const id2 = redshiftBindRow(entry, SDK_KEY, SDK_VERSION)[0]
    expect(id1).not.toBe(id2)
  })
})

// ---------------------------------------------------------------------------
// ClickHouse bindRow — canonical column tests
// ---------------------------------------------------------------------------

describe('ClickHouse bindRow', () => {
  const entry = makeEntry()
  const SDK_KEY = 'ch-sdk-key'
  const SDK_VERSION = '2.1.0'

  it('produces all 14 canonical column keys', () => {
    const row = clickhouseBindRow(entry, SDK_KEY, SDK_VERSION)
    const expected = [
      'decision_id', 'flag_key', 'context_kind', 'context_key',
      'variation_key', 'value', 'source', 'rule_id', 'rule_type',
      'reasons', 'evaluated_at', 'duration_micros', 'sdk_key', 'sdk_version',
    ]
    for (const col of expected) {
      expect(row).toHaveProperty(col)
    }
  })

  it('decision_id is a valid UUID v4', () => {
    const row = clickhouseBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row['decision_id']).toMatch(UUID_RE)
  })

  it('derives context_kind and context_key from single contextSummary', () => {
    const row = clickhouseBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row['context_kind']).toBe('user')
    expect(row['context_key']).toBe('u_1')
  })

  it('derives kind=multi and joined keys from multi-context contextSummary', () => {
    const multiEntry = makeEntry({
      contextSummary: [
        { kind: 'user', key: 'u_5' },
        { kind: 'session', key: 's_99' },
      ],
    })
    const row = clickhouseBindRow(multiEntry, SDK_KEY, SDK_VERSION)
    expect(row['context_kind']).toBe('multi')
    expect(row['context_key']).toBe('u_5,s_99')
  })

  it('sdk_key and sdk_version flow through correctly', () => {
    const row = clickhouseBindRow(entry, SDK_KEY, SDK_VERSION)
    expect(row['sdk_key']).toBe(SDK_KEY)
    expect(row['sdk_version']).toBe(SDK_VERSION)
  })

  it('each invocation produces a unique decision_id', () => {
    const id1 = clickhouseBindRow(entry, SDK_KEY, SDK_VERSION)['decision_id']
    const id2 = clickhouseBindRow(entry, SDK_KEY, SDK_VERSION)['decision_id']
    expect(id1).not.toBe(id2)
  })
})
