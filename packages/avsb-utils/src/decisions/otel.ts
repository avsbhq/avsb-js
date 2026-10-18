// OpenTelemetry decision sink. Emits one span event per `DecisionLogEntry`
// on the supplied tracer/exporter. Exporter is duck-typed to avoid pulling
// in @opentelemetry/api as a hard dep.

import type { DecisionLogEntry } from '@avsbhq/core'
import type { DecisionSink } from '../decisions'

export interface OtelExporter {
  export(
    spans: Array<{
      name: string
      attributes: Record<string, unknown>
      startTime: number
    }>
  ): Promise<void> | void
}

export interface OtelSinkOptions {
  exporter: OtelExporter
  /** Span name. Default 'avsb.decision'. */
  spanName?: string
}

export function createOtelSink(opts: OtelSinkOptions): DecisionSink {
  const spanName = opts.spanName ?? 'avsb.decision'
  return {
    name: 'otel',
    async write(batch) {
      const spans = batch.map((entry) => ({
        name: spanName,
        startTime: entry.evaluatedAt,
        attributes: {
          'avsb.flag.key': entry.flagKey,
          'avsb.flag.variation': entry.variationKey ?? '',
          'avsb.flag.source': entry.source,
          'avsb.flag.rule_id': entry.ruleId ?? '',
          'avsb.flag.rule_type': entry.ruleType ?? '',
          'avsb.flag.duration_micros': entry.durationMicros,
          'avsb.flag.context_keys': entry.contextSummary
            .map((c) => `${c.kind}:${c.key}`)
            .join(','),
        },
      }))
      await opts.exporter.export(spans)
    },
  }
}
